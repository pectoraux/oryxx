// ORYXX — Open-Meteo Weather Adapter (OBSERVED_ONLY)
//
// This adapter connects to the Open-Meteo weather API to observe real
// current-weather conditions at any geographic point on Earth. Open-Meteo
// is free, requires NO authentication, NO API key, and provides
// near-real-time observed weather data sourced from national weather
// services (ECMWF, DWD, NOAA, MeteoFrance, etc.).
//
// Classification: OBSERVED_ONLY
// - getWeather: YES — real current weather observations from Open-Meteo API
// - quote: NO — weather is not transactional
// - reserve: NO — N/A
// - acceptOffer: NO — N/A
// - startExecution: NO — N/A
// - verifyCompletion: NO — N/A
//
// This adapter CANNOT produce W3-M/W4-M evidence because it observes weather
// conditions only — it is not a marketplace counterparty. It feeds the
// Traffic/Incident/Weather input layer (subsystem AA) so the solver can
// degrade ETAs, surface weather-related incidents, and tag routing risk.
//
// Data source: https://api.open-meteo.com/v1/forecast (Open-Meteo — public, no auth)
// Coverage: GLOBAL (any lat/lon)
// Data freshness: current conditions, typically updated every 5-15 minutes
// Auth: none (anonymous)
// Rate limit: Open-Meteo free tier permits up to ~10,000 requests/day per IP;
//   this adapter enforces a MINIMUM 1000ms gap between outgoing requests and
//   a 5-minute TTL cache to stay well within that budget.
//
// REALITY POLICY: On ANY failure (network error, HTTP 4xx/5xx, parse error,
// rate-limit 429, malformed payload) the adapter returns `null`. It NEVER
// fabricates weather data and NEVER throws to the caller.

import type {
  ConnectionStatus,
  GeoPoint,
  Observation,
  ObservationBasis,
  Provenance,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const PROVIDER_ID = "open-meteo-weather";
const PROVIDER_NAME = "Open-Meteo Weather";
const PROVIDER_COVERAGE = "Global";
const PROVIDER_DATA_SOURCE =
  "Open-Meteo API (https://api.open-meteo.com/v1/forecast)";

// Minimum gap between outgoing API calls — protects the free-tier quota.
const MIN_REQUEST_INTERVAL_MS = 1000;
// Current weather changes slowly; cache 5 minutes.
const CACHE_TTL_MS = 5 * 60 * 1000;
// Per-request hard timeout so a hung socket cannot wedge the adapter.
const REQUEST_TIMEOUT_MS = 10_000;

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

export type WeatherSeverity = "none" | "info" | "warn" | "critical";

export interface WeatherObservation {
  lat: number;
  lon: number;
  temperatureC: number;
  apparentTemperatureC: number;
  windSpeedKmh: number;
  precipitationMm: number;
  relativeHumidityPct: number;
  weatherCode: number;
  weatherLabel: string;
  severity: WeatherSeverity;
  observedAt: string; // ISO
  provenance: Provenance;
}

interface OpenMeteoCurrentPayload {
  time: string;
  interval: number;
  temperature_2m: number;
  wind_speed_10m: number;
  precipitation: number;
  weather_code: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  elevation: number;
  current: OpenMeteoCurrentPayload;
}

// ═══════════════════════════════════════════════════════════════════════
// WMO WEATHER CODE INTERPRETATION
// ═══════════════════════════════════════════════════════════════════════
//
// WMO weather interpretation codes (WW) as documented by Open-Meteo.
// Reference: https://open-meteo.com/en/docs (WMO Weather interpretation codes)
//
// Severity policy:
//   "none"     — clear / partly cloudy — no operational impact
//   "info"     — fog, light drizzle — minor visibility impact
//   "warn"     — rain, snow showers — moderate operational impact (ETA risk)
//   "critical"— heavy rain, thunderstorm, heavy snow — significant impact

export function describeWeatherCode(code: number): {
  label: string;
  severity: WeatherSeverity;
} {
  // Clear
  if (code === 0) return { label: "Clear sky", severity: "none" };

  // Partly cloudy
  if (code === 1) return { label: "Mainly clear", severity: "none" };
  if (code === 2) return { label: "Partly cloudy", severity: "none" };
  if (code === 3) return { label: "Overcast", severity: "info" };

  // Fog
  if (code === 45) return { label: "Fog", severity: "info" };
  if (code === 48) return { label: "Depositing rime fog", severity: "info" };

  // Drizzle (light → moderate → dense)
  if (code === 51) return { label: "Light drizzle", severity: "info" };
  if (code === 53) return { label: "Moderate drizzle", severity: "warn" };
  if (code === 55) return { label: "Dense drizzle", severity: "warn" };
  if (code === 56)
    return { label: "Light freezing drizzle", severity: "warn" };
  if (code === 57)
    return { label: "Dense freezing drizzle", severity: "critical" };

  // Rain (light → moderate → heavy)
  if (code === 61) return { label: "Slight rain", severity: "warn" };
  if (code === 63) return { label: "Moderate rain", severity: "warn" };
  if (code === 65) return { label: "Heavy rain", severity: "critical" };
  if (code === 66) return { label: "Light freezing rain", severity: "warn" };
  if (code === 67) return { label: "Heavy freezing rain", severity: "critical" };

  // Snow
  if (code === 71) return { label: "Slight snow fall", severity: "warn" };
  if (code === 73) return { label: "Moderate snow fall", severity: "warn" };
  if (code === 75) return { label: "Heavy snow fall", severity: "critical" };
  if (code === 77) return { label: "Snow grains", severity: "warn" };

  // Rain showers
  if (code === 80) return { label: "Slight rain showers", severity: "warn" };
  if (code === 81) return { label: "Moderate rain showers", severity: "warn" };
  if (code === 82) return { label: "Violent rain showers", severity: "critical" };

  // Snow showers
  if (code === 85) return { label: "Slight snow showers", severity: "warn" };
  if (code === 86) return { label: "Heavy snow showers", severity: "critical" };

  // Thunderstorm
  if (code === 95) return { label: "Thunderstorm", severity: "critical" };
  if (code === 96)
    return { label: "Thunderstorm with slight hail", severity: "critical" };
  if (code === 99)
    return { label: "Thunderstorm with heavy hail", severity: "critical" };

  // Unknown code — be conservative
  return { label: `Unknown weather code ${code}`, severity: "info" };
}

// ═══════════════════════════════════════════════════════════════════════
// OPEN-METEO WEATHER ADAPTER
// ═══════════════════════════════════════════════════════════════════════

interface CacheEntry {
  observed: WeatherObservation;
  cachedAt: number; // epoch ms
}

class OpenMeteoWeatherAdapter {
  // Identity
  readonly providerId = PROVIDER_ID;
  readonly providerName = PROVIDER_NAME;
  readonly coverage = PROVIDER_COVERAGE;
  readonly dataSource = PROVIDER_DATA_SOURCE;
  readonly environment = "OBSERVED_ONLY" as const;

  // Connection state
  private lastHealthCheck: string | null = null;
  private lastHealthCheckSuccess = false;
  private lastError: string | null = null;
  private lastLatencyMs: number | null = null;

  // Rate limiting
  private lastRequestAt = 0;

  // Cache keyed by "lat,lon" rounded to 4 decimal places (~11m).
  private cache = new Map<string, CacheEntry>();

  // ── CONNECTION STATUS ──────────────────────────────────────────────

  getConnectionStatus(): ConnectionStatus {
    // Always OBSERVED_ONLY — this adapter cannot execute marketplace ops.
    return "OBSERVED_ONLY";
  }

  // ── HEALTH CHECK (operator dashboard) ──────────────────────────────

  async healthCheck(): Promise<{
    connected: boolean;
    latencyMs: number;
    error: string | null;
    timestamp: string;
  }> {
    const start = Date.now();
    try {
      // Probe with a stable, low-cost coordinate (0,0 — Gulf of Guinea).
      // We bypass the cache here so the probe actually hits the API.
      const url =
        `${OPEN_METEO_BASE}?latitude=0&longitude=0` +
        `&current=temperature_2m&timezone=auto`;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - start;
      this.lastHealthCheck = new Date().toISOString();

      if (!response.ok) {
        // 429 / 5xx → connected=false but the host WAS reachable.
        const body = await safeReadText(response);
        throw new Error(
          `HTTP ${response.status}${body ? `: ${truncate(body, 200)}` : ""}`,
        );
      }

      const data = (await response.json()) as Partial<OpenMeteoResponse>;
      if (!data || typeof data !== "object" || !data.current) {
        throw new Error("malformed payload (missing current)");
      }

      this.lastHealthCheckSuccess = true;
      this.lastError = null;
      this.lastLatencyMs = latencyMs;

      return {
        connected: true,
        latencyMs,
        error: null,
        timestamp: this.lastHealthCheck,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      this.lastHealthCheck = new Date().toISOString();
      this.lastHealthCheckSuccess = false;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.lastLatencyMs = latencyMs;

      return {
        connected: false,
        latencyMs,
        error: message,
        timestamp: this.lastHealthCheck,
      };
    }
  }

  // ── CORE: getWeather ────────────────────────────────────────────────

  async getWeather(point: GeoPoint): Promise<WeatherObservation | null> {
    if (
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lon) ||
      point.lat < -90 ||
      point.lat > 90 ||
      point.lon < -180 ||
      point.lon > 180
    ) {
      return null;
    }

    const key = cacheKey(point.lat, point.lon);

    // 1. Cache hit?
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.observed;
    }

    // 2. Rate limit — wait if we just made a request.
    await this.enforceRateLimit();

    // 3. Fetch.
    const url =
      `${OPEN_METEO_BASE}?latitude=${point.lat}&longitude=${point.lon}` +
      `&current=temperature_2m,wind_speed_10m,precipitation,weather_code,` +
      `relative_humidity_2m,apparent_temperature&timezone=auto`;

    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.lastRequestAt = Date.now();

      if (!response.ok) {
        const body = await safeReadText(response);
        this.lastError = `HTTP ${response.status}${
          body ? `: ${truncate(body, 200)}` : ""
        }`;
        this.lastHealthCheckSuccess = false;
        return null;
      }

      const data = (await response.json()) as OpenMeteoResponse;
      const cur = data?.current;
      if (!cur || typeof cur !== "object") {
        this.lastError = "malformed payload (missing current)";
        return null;
      }

      // Validate required numeric fields exist + are finite.
      const required: Array<keyof OpenMeteoCurrentPayload> = [
        "temperature_2m",
        "wind_speed_10m",
        "precipitation",
        "weather_code",
        "relative_humidity_2m",
        "apparent_temperature",
      ];
      for (const k of required) {
        const v = cur[k];
        if (v === null || typeof v !== "number" || !Number.isFinite(v)) {
          this.lastError = `malformed payload (field ${String(k)} invalid)`;
          return null;
        }
      }

      const observedAt = normalizeIso(cur.time, data.utc_offset_seconds);

      const { label, severity } = describeWeatherCode(cur.weather_code);

      const provenance: Provenance = {
        environment: "OBSERVED_ONLY",
        source: "open-meteo",
        observedAt,
        confidence: 0.9,
      };

      const observation: WeatherObservation = {
        lat: roundCoord(data.latitude ?? point.lat),
        lon: roundCoord(data.longitude ?? point.lon),
        temperatureC: cur.temperature_2m,
        apparentTemperatureC: cur.apparent_temperature,
        windSpeedKmh: cur.wind_speed_10m,
        precipitationMm: cur.precipitation,
        relativeHumidityPct: cur.relative_humidity_2m,
        weatherCode: cur.weather_code,
        weatherLabel: label,
        severity,
        observedAt,
        provenance,
      };

      this.cache.set(key, { observed: observation, cachedAt: Date.now() });
      this.lastHealthCheckSuccess = true;
      this.lastError = null;

      return observation;
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastHealthCheckSuccess = false;
      return null;
    }
  }

  // ── RATE LIMITER ────────────────────────────────────────────────────

  private async enforceRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed >= MIN_REQUEST_INTERVAL_MS) return;
    const wait = MIN_REQUEST_INTERVAL_MS - elapsed;
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ORYXX Observation MAPPING
// ═══════════════════════════════════════════════════════════════════════
//
// The current ORYXX ObservationType union is:
//   "traffic" | "road-closure" | "vehicle-availability" | "unsafe-zone" |
//   "transit-disruption" | "parking" | "loading-zone"
//
// There is no dedicated "weather" variant. We DO NOT add one here (that would
// be a non-trivial change touching the ObservationType union, downstream
// consumers, and the operator dashboard). Instead, weather observations are
// mapped to "unsafe-zone" when severity is warn/critical (weather materially
// affects routing safety), or returned as WeatherObservation without an
// Observation wrapper when severity is none/info. Callers that need the raw
// weather fields should consume WeatherObservation directly.
//
// This gap (no first-class weather ObservationType) is noted in worklog Task 4.

export function toObservation(w: WeatherObservation): Observation | null {
  if (w.severity !== "warn" && w.severity !== "critical") {
    // Benign weather (clear / partly cloudy / fog) does not need to surface
    // as an unsafe-zone Observation. Callers should consume the
    // WeatherObservation directly.
    return null;
  }

  const basis: ObservationBasis = "OBSERVED";
  const severityNote =
    w.severity === "critical" ? "critical weather" : "adverse weather";

  return {
    id: `weather-${w.lat.toFixed(4)}-${w.lon.toFixed(4)}-${w.observedAt}`,
    source: "open-meteo",
    observer: "open-meteo-weather",
    timestamp: w.observedAt,
    location: { lat: w.lat, lon: w.lon },
    type: "unsafe-zone",
    basis,
    confidence: w.provenance.confidence ?? 0.9,
    payload: {
      kind: "weather",
      severity: w.severity,
      severityNote,
      weatherCode: w.weatherCode,
      weatherLabel: w.weatherLabel,
      temperatureC: w.temperatureC,
      apparentTemperatureC: w.apparentTemperatureC,
      windSpeedKmh: w.windSpeedKmh,
      precipitationMm: w.precipitationMm,
      relativeHumidityPct: w.relativeHumidityPct,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function cacheKey(lat: number, lon: number): string {
  return `${roundCoord(lat)},${roundCoord(lon)}`;
}

function roundCoord(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Open-Meteo returns `current.time` in the LOCAL timezone of the queried
// point (because we pass timezone=auto), with utc_offset_seconds telling us
// the offset. We convert to a UTC ISO string for canonical storage.
function normalizeIso(
  localTime: string | undefined,
  utcOffsetSeconds: number | undefined,
): string {
  if (!localTime) return new Date().toISOString();
  // Open-Meteo local times look like "2024-08-21T15:53" (no tz).
  const parsed = new Date(localTime);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  if (typeof utcOffsetSeconds !== "number") {
    return parsed.toISOString();
  }
  // parsed was constructed as if localTime were UTC by the JS runtime
  // (no tz suffix). Subtract the offset to recover true UTC.
  const utcMs = parsed.getTime() - utcOffsetSeconds * 1000;
  return new Date(utcMs).toISOString();
}

// ═══════════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════════

export const openMeteoWeather = new OpenMeteoWeatherAdapter();
