// ORYXX — OSM Nominatim Geocoding Adapter (OBSERVED_ONLY)
//
// This adapter connects to the public OpenStreetMap Nominatim API to resolve
// real-world place names → coordinates (forward geocoding) and coordinates →
// place names (reverse geocoding). It provides REAL observed geographic
// data but does NOT support any transactional operation.
//
// Classification: OBSERVED_ONLY
//   - geocode(query)         : YES — real OSM place search
//   - reverseGeocode(point)  : YES — real OSM reverse lookup
//   - quote / reserve / accept / execute / verifyCompletion: NO (not a
//     transportation provider — see data-source-registry.ts)
//
// This adapter CANNOT produce W3-M/W4-M evidence. It provides real observed
// geographic coordinates that can be used by the solver, the OpportunityEngine,
// and routing adapters to ground plans in the real road network.
//
// API: https://nominatim.openstreetmap.org (public, no auth)
// Usage policy (MANDATORY — Nominatim is operated by OSM Foundation):
//   - Must send a valid identifiable User-Agent / Referer header
//   - Must rate-limit ≤ 1 request/sec (we enforce ≥ 1100ms between calls)
//   - Must not use for heavy bulk queries
// Coverage: Global (OpenStreetMap planet)
// Data freshness: depends on OSM contributor edits; usually minutes-to-days
//
// FAILURE POLICY (strict — no synthetic fallback):
//   On ANY failure (network error, non-2xx HTTP, 429 rate-limit, timeout,
//   parse error): return [] for geocode() and null for reverseGeocode().
//   NEVER return fake coordinates. NEVER throw to the caller.

import type { Environment, GeoPoint, Provenance } from "../types";
import "./node-connectivity-fix"; // apply IPv4-first DNS fix for Node fetch (no-op on Bun/browser)

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "ORYXX/0.2 (transportation operating system)";
const REFERER = "https://oryxx.app/";

const MIN_INTERVAL_MS = 1100; // ≥1.1s between requests (Nominatim policy)
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minute TTL
const REQUEST_TIMEOUT_MS = 12_000; // 12s per-request timeout
const CONFIDENCE = 0.9; // high confidence — real OSM data, but observed-only
const SOURCE_TAG = "osm" as const;

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface GeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
  type?: string;
  importance?: number;
  provenance: Provenance;
}

export interface OsmGeocoderCapabilities {
  forwardGeocoding: true;
  reverseGeocoding: true;
  transactional: false;
}

export interface OsmGeocoderProvenance {
  environment: Environment;
  source: "osm";
  dataSource: string;
  coverage: string;
  lastUpdated: string | null;
  lastError: string | null;
}

// ═══════════════════════════════════════════════════════════════════════
// NOMINATIM API SHAPE (subset we parse)
// ═══════════════════════════════════════════════════════════════════════

interface NominatimForwardItem {
  lat: string; // string per Nominatim JSON spec
  lon: string;
  display_name: string;
  type?: string;
  importance?: number;
}

interface NominatimReverseItem {
  lat: string;
  lon: string;
  display_name: string;
  type?: string;
  importance?: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// IN-PROCESS RATE LIMITER
// ═══════════════════════════════════════════════════════════════════════
//
// Nominatim usage policy REQUIRES ≤ 1 req/sec. We serialize all requests
// through a single async queue and enforce a minimum interval between
// dispatches. This is per-process (acceptable for a sandboxed dev server);
// a production deployment would move this to a distributed limiter.

class RateLimiter {
  private lastDispatchMs = 0;
  private pendingChain: Promise<void> = Promise.resolve();

  /** Reserve the next available slot, returning a function that releases it. */
  async acquire(): Promise<void> {
    // Chain onto whatever is currently pending so requests serialize.
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.pendingChain;
    this.pendingChain = prev.then(() => slot);

    await prev;

    const now = Date.now();
    const elapsed = now - this.lastDispatchMs;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    this.lastDispatchMs = Date.now();

    // Re-chain the release so the next acquire() can start its wait after ours.
    release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════
// TTL CACHE
// ═══════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// OSM NOMINATIM ADAPTER
// ═══════════════════════════════════════════════════════════════════════

class OsmGeocoder {
  private readonly rateLimiter = new RateLimiter();
  private readonly forwardCache = new TtlCache<GeocodeResult[]>();
  private readonly reverseCache = new TtlCache<GeocodeResult | null>();

  private lastUpdatedAt: string | null = null;
  private lastError: string | null = null;

  // ── ACCESSORS ─────────────────────────────────────────────────────

  getCapabilities(): OsmGeocoderCapabilities {
    return { forwardGeocoding: true, reverseGeocoding: true, transactional: false };
  }

  getProvenance(): OsmGeocoderProvenance {
    return {
      environment: "OBSERVED_ONLY",
      source: SOURCE_TAG,
      dataSource: "OpenStreetMap Nominatim (https://nominatim.openstreetmap.org)",
      coverage: "Global (OpenStreetMap planet)",
      lastUpdated: this.lastUpdatedAt,
      lastError: this.lastError,
    };
  }

  /** Build a Provenance stamp for a single observed result. */
  private makeProvenance(): Provenance {
    return {
      environment: "OBSERVED_ONLY",
      source: SOURCE_TAG,
      observedAt: new Date().toISOString(),
      confidence: CONFIDENCE,
    };
  }

  // ── FORWARD GEOCODE ──────────────────────────────────────────────

  async geocode(query: string): Promise<GeocodeResult[]> {
    const trimmed = (query ?? "").trim();
    if (!trimmed) return [];

    const cacheKey = `fwd:${trimmed.toLowerCase()}`;
    const cached = this.forwardCache.get(cacheKey);
    if (cached) return cached;

    try {
      await this.rateLimiter.acquire();

      const url = new URL(`${NOMINATIM_BASE}/search`);
      url.searchParams.set("q", trimmed);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "5");
      url.searchParams.set("addressdetails", "0");

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Referer: REFERER,
          Accept: "application/json",
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.lastError = `Nominatim search returned HTTP ${response.status}`;
        return []; // NEVER throw — caller handles []
      }

      const raw = (await response.json()) as NominatimForwardItem[];
      if (!Array.isArray(raw)) {
        this.lastError = "Nominatim search returned non-array JSON";
        return [];
      }

      const results: GeocodeResult[] = [];
      for (const item of raw) {
        const parsed = this.parseItem(item);
        if (parsed) results.push(parsed);
      }

      this.lastUpdatedAt = new Date().toISOString();
      this.lastError = null;
      this.forwardCache.set(cacheKey, results, CACHE_TTL_MS);
      return results;
    } catch (err: any) {
      this.lastError = err?.name === "TimeoutError"
        ? `Nominatim search timed out after ${REQUEST_TIMEOUT_MS}ms`
        : err?.message || String(err);
      return [];
    }
  }

  // ── REVERSE GEOCODE ───────────────────────────────────────────────

  async reverseGeocode(point: GeoPoint): Promise<GeocodeResult | null> {
    if (!this.isValidPoint(point)) return null;

    const cacheKey = `rev:${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
    const cached = this.reverseCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      await this.rateLimiter.acquire();

      const url = new URL(`${NOMINATIM_BASE}/reverse`);
      url.searchParams.set("format", "json");
      url.searchParams.set("lat", String(point.lat));
      url.searchParams.set("lon", String(point.lon));
      url.searchParams.set("addressdetails", "0");

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Referer: REFERER,
          Accept: "application/json",
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.lastError = `Nominatim reverse returned HTTP ${response.status}`;
        this.reverseCache.set(cacheKey, null, CACHE_TTL_MS);
        return null;
      }

      const raw = (await response.json()) as NominatimReverseItem;
      if (!raw || raw.error) {
        this.lastError = raw?.error || "Nominatim reverse returned no result";
        this.reverseCache.set(cacheKey, null, CACHE_TTL_MS);
        return null;
      }

      const parsed = this.parseItem(raw);
      if (!parsed) {
        this.reverseCache.set(cacheKey, null, CACHE_TTL_MS);
        return null;
      }

      this.lastUpdatedAt = new Date().toISOString();
      this.lastError = null;
      this.reverseCache.set(cacheKey, parsed, CACHE_TTL_MS);
      return parsed;
    } catch (err: any) {
      this.lastError = err?.name === "TimeoutError"
        ? `Nominatim reverse timed out after ${REQUEST_TIMEOUT_MS}ms`
        : err?.message || String(err);
      return null;
    }
  }

  // ── HELPERS ──────────────────────────────────────────────────────

  private isValidPoint(p: GeoPoint | null | undefined): p is GeoPoint {
    return (
      !!p &&
      typeof p.lat === "number" &&
      typeof p.lon === "number" &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      p.lat >= -90 &&
      p.lat <= 90 &&
      p.lon >= -180 &&
      p.lon <= 180
    );
  }

  private parseItem(item: NominatimForwardItem | NominatimReverseItem): GeocodeResult | null {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return {
      lat,
      lon,
      displayName: item.display_name ?? "",
      type: item.type,
      importance: typeof item.importance === "number" ? item.importance : undefined,
      provenance: this.makeProvenance(),
    };
  }

  // ── CACHE CONTROL (for tests / ops) ───────────────────────────────

  clearCache(): void {
    this.forwardCache.clear();
    this.reverseCache.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════════

export const osmGeocoder = new OsmGeocoder();
