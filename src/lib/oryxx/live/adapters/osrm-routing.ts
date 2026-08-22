// ORYXX — OSRM Routing Adapter (OBSERVED_ONLY)
//
// This adapter connects to the public OSRM demo server to compute real
// point-to-point routes on the OpenStreetMap road network. It provides
// REAL observed distances, durations, and route geometries but does NOT
// support any transactional operation.
//
// Classification: OBSERVED_ONLY
//   - route(points, profile)         : YES — real OSRM route
//   - travelTimeSec(from, to, prof)  : YES — real OSRM duration
//   - quote / reserve / accept / execute / verifyCompletion: NO (not a
//     transportation provider — see data-source-registry.ts)
//
// This adapter CANNOT produce W3-M/W4-M evidence. It provides real road
// network distances/times that the solver and OpportunityEngine use to
// ground candidate routes in physical reality.
//
// API: https://router.project-osrm.org/route/v1/<profile>/<coords> (public, no auth)
// Coverage: global road network (OSM-derived); driving profile is fully
//   supported on the demo server. walking (foot) / cycling (bike) profiles
//   exist but coverage is more limited — if the upstream returns 4xx/5xx
//   for a non-driving profile, this adapter returns null for that call
//   (it does NOT silently fall back to driving).
//
// IMPORTANT — COORDINATE ORDER:
//   OSRM expects LON,LAT (longitude first), not lat,lon. This adapter
//   converts from ORYXX's GeoPoint {lat, lon} convention internally.
//
// RATE LIMITING:
//   The OSRM demo server does not publish a strict rate limit, but to be
//   a good citizen (and to coexist with other adapters hitting shared
//   egress), we enforce the same ≥1100ms interval + 10-minute TTL cache
//   used by the geocoder. Heavier deployments should self-host OSRM.
//
// FAILURE POLICY (strict — no synthetic fallback):
//   On ANY failure (network error, non-2xx HTTP, 4xx/5xx for an unsupported
//   profile, timeout, parse error, zero-route response): return null. NEVER
//   return fake distances/times. NEVER silently substitute driving for a
//   requested walk/bike profile. NEVER throw to the caller.
//
// PROVENANCE CONFIDENCE NOTE:
//   Confidence is 0.85 (not 0.95) because the OSRM demo server is not a
//   guaranteed-SLA production endpoint. It is real road network data but
//   its availability/latency is best-effort.

import type { Environment, GeoPoint, Provenance } from "../types";
import "./node-connectivity-fix"; // apply IPv4-first DNS fix for Node fetch (no-op on Bun/browser)

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const OSRM_BASE = "https://router.project-osrm.org";
const USER_AGENT = "ORYXX/0.2 (transportation operating system)";

const MIN_INTERVAL_MS = 1100; // be a good citizen on the shared demo server
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minute TTL (routes don't change often)
const REQUEST_TIMEOUT_MS = 15_000; // OSRM route computation can be slower
const CONFIDENCE = 0.85; // OSRM demo is not SLA-backed

const SOURCE_TAG = "osrm" as const;

// ORYXX external profile names → OSRM internal profile names.
const PROFILE_MAP: Record<"walk" | "bike" | "dr", string> = {
  walk: "foot",
  bike: "bike",
  dr: "driving",
};

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════

export type RoutingProfile = "walk" | "bike" | "dr";

export interface RouteResult {
  distanceKm: number;
  durationSec: number;
  geometry: GeoPoint[];
  profile: string; // the OSRM profile name actually used (e.g. "driving")
  provenance: Provenance;
}

export interface OsrmRouterCapabilities {
  routing: true;
  profilesSupported: RoutingProfile[];
  transactional: false;
}

export interface OsrmRouterProvenance {
  environment: Environment;
  source: "osrm";
  dataSource: string;
  coverage: string;
  lastUpdated: string | null;
  lastError: string | null;
}

// ═══════════════════════════════════════════════════════════════════════
// OSRM API SHAPE (subset we parse)
// ═══════════════════════════════════════════════════════════════════════

interface OsrmRoute {
  distance: number; // meters
  duration: number; // seconds
  geometry: {
    coordinates: [number, number][]; // [lon, lat] pairs (geojson)
  };
}

interface OsrmResponse {
  code: string; // "Ok" on success
  message?: string;
  routes?: OsrmRoute[];
}

// ═══════════════════════════════════════════════════════════════════════
// RATE LIMITER + CACHE (shared pattern with the geocoder; kept separate so
// each adapter has its own queue and does not starve the other)
// ═══════════════════════════════════════════════════════════════════════

class RateLimiter {
  private lastDispatchMs = 0;
  private pendingChain: Promise<void> = Promise.resolve();

  async acquire(): Promise<void> {
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
    release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ═══════════════════════════════════════════════════════════════════════
// OSRM ADAPTER
// ═══════════════════════════════════════════════════════════════════════

class OsrmRouter {
  private readonly rateLimiter = new RateLimiter();
  private readonly routeCache = new TtlCache<RouteResult | null>();

  private lastUpdatedAt: string | null = null;
  private lastError: string | null = null;

  // ── ACCESSORS ─────────────────────────────────────────────────────

  getCapabilities(): OsrmRouterCapabilities {
    return {
      routing: true,
      // All three are *attempted*; the demo server may reject foot/bike.
      profilesSupported: ["walk", "bike", "dr"],
      transactional: false,
    };
  }

  getProvenance(): OsrmRouterProvenance {
    return {
      environment: "OBSERVED_ONLY",
      source: SOURCE_TAG,
      dataSource: "OSRM demo server (https://router.project-osrm.org)",
      coverage: "Global road network (OpenStreetMap-derived)",
      lastUpdated: this.lastUpdatedAt,
      lastError: this.lastError,
    };
  }

  private makeProvenance(): Provenance {
    return {
      environment: "OBSERVED_ONLY",
      source: SOURCE_TAG,
      observedAt: new Date().toISOString(),
      confidence: CONFIDENCE,
      validFrom: new Date().toISOString(),
      validTo: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    };
  }

  // ── ROUTE ────────────────────────────────────────────────────────

  async route(
    points: GeoPoint[],
    profile: RoutingProfile,
  ): Promise<RouteResult | null> {
    // Need at least an origin + destination.
    if (!Array.isArray(points) || points.length < 2) return null;

    const valid = points.every((p) => this.isValidPoint(p));
    if (!valid) return null;

    const osrmProfile = PROFILE_MAP[profile];
    if (!osrmProfile) {
      this.lastError = `Unknown routing profile: ${profile}`;
      return null;
    }

    const cacheKey = this.cacheKey(points, profile);
    const cached = this.routeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      await this.rateLimiter.acquire();

      // OSRM expects LON,LAT — semicolon-separated.
      const coordStr = points
        .map((p) => `${this.toFixed(p.lon)},${this.toFixed(p.lat)}`)
        .join(";");

      const url = new URL(`${OSRM_BASE}/route/v1/${osrmProfile}/${coordStr}`);
      url.searchParams.set("overview", "full");
      url.searchParams.set("geometries", "geojson");

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        // 4xx/5xx for the requested profile → null. Do NOT substitute driving.
        this.lastError = `OSRM returned HTTP ${response.status} for profile ${osrmProfile}`;
        this.routeCache.set(cacheKey, null, CACHE_TTL_MS);
        return null;
      }

      const raw = (await response.json()) as OsrmResponse;
      if (!raw || raw.code !== "Ok" || !raw.routes || raw.routes.length === 0) {
        this.lastError = raw?.message
          ? `OSRM error code=${raw.code} message=${raw.message}`
          : `OSRM returned code=${raw?.code ?? "?"} with no routes`;
        this.routeCache.set(cacheKey, null, CACHE_TTL_MS);
        return null;
      }

      const first = raw.routes[0];
      if (
        typeof first.distance !== "number" ||
        typeof first.duration !== "number" ||
        !Array.isArray(first.geometry?.coordinates)
      ) {
        this.lastError = "OSRM response missing distance/duration/geometry";
        this.routeCache.set(cacheKey, null, CACHE_TTL_MS);
        return null;
      }

      // Convert geojson [lon,lat] pairs → ORYXX GeoPoint {lat, lon}.
      const geometry: GeoPoint[] = first.geometry.coordinates.map(
        ([lon, lat]: [number, number]) => ({ lat, lon }),
      );

      const result: RouteResult = {
        distanceKm: first.distance / 1000,
        durationSec: first.duration,
        geometry,
        profile: osrmProfile,
        provenance: this.makeProvenance(),
      };

      this.lastUpdatedAt = new Date().toISOString();
      this.lastError = null;
      this.routeCache.set(cacheKey, result, CACHE_TTL_MS);
      return result;
    } catch (err: any) {
      // Bun's fetch wraps connection-level errors as a generic TypeError
      // "fetch failed" with the real cause under err.cause. We surface both
      // for ops visibility (cause.code is usually ETIMEDOUT / ENOTFOUND /
      // ECONNRESET on Node; Bun uses the same shape).
      const cause: any = err?.cause;
      this.lastError = err?.name === "TimeoutError"
        ? `OSRM request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : cause?.code
          ? `OSRM fetch failed: ${cause.code} (${cause.message ?? err?.message ?? ""})`
          : err?.message || String(err);
      return null;
    }
  }

  // ── TRAVEL TIME HELPER ────────────────────────────────────────────

  async travelTimeSec(
    from: GeoPoint,
    to: GeoPoint,
    profile: RoutingProfile,
  ): Promise<number | null> {
    const r = await this.route([from, to], profile);
    if (!r) return null;
    return r.durationSec;
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

  private toFixed(n: number): string {
    // 6 decimal places ≈ 11cm — plenty for routing endpoints.
    return n.toFixed(6);
  }

  private cacheKey(points: GeoPoint[], profile: RoutingProfile): string {
    const coords = points
      .map((p) => `${this.toFixed(p.lat)},${this.toFixed(p.lon)}`)
      .join(";");
    return `${profile}:${coords}`;
  }

  // ── CACHE CONTROL ─────────────────────────────────────────────────

  clearCache(): void {
    this.routeCache.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════════

export const osrmRouter = new OsrmRouter();
