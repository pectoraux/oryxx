// ORYXX — Citi Bike NYC Provider Adapter (OBSERVED_ONLY)
//
// This adapter connects to the CityBik.es API to observe real Citi Bike
// station data in New York City. It provides REAL observed supply (bikes
// available at stations) but does NOT support transactional acceptance,
// execution, or completion verification.
//
// Classification: OBSERVED_ONLY
// - discoverSupply: YES — real station data from CityBik.es API
// - quote: NO — no pricing API
// - reserve: NO — no reservation API
// - acceptOffer: NO — NOT_SUPPORTED (observed-only provider)
// - startExecution: NO — NOT_SUPPORTED
// - verifyCompletion: NO — NOT_SUPPORTED
//
// This provider CANNOT produce W3-M/W4-M evidence because it cannot
// accept or execute marketplace offers. It provides real observed supply
// data that can be used by the OpportunityEngine to discover real-world
// transportation opportunities.
//
// API: https://api.citybik.es/v2/ (CityBik.es — public, no auth required)
// Network: citi-bike-nyc (Citi Bike, New York, NY, US)
// Coverage: New York City (all 5 boroughs + Jersey City/Hoboken)
// Data freshness: near-real-time (stations update every few minutes)

import type {
  Environment,
  GeoPoint,
  ProviderCapabilities,
  ProviderIdentity,
  ProviderType,
  TransportationDemand,
  TransportationResource,
  TransportationSupply,
  ConnectionStatus,
  Provenance,
  TimeWindow,
  ProviderProvenance,
  ProviderIntegrationStatus,
} from "../types";
import type {
  TransportationProviderAdapter,
  QuoteRequest,
  QuoteResult,
  ReserveRequest,
  ReserveResult,
  ExecutionStatus,
} from "./provider-registry";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const CITYBIK_API_BASE = "https://api.citybik.es/v2";
const CITI_BIKE_NETWORK_ID = "citi-bike-nyc";
const PROVIDER_ID = "citi-bike-nyc";
const PROVIDER_NAME = "Citi Bike NYC";
const PROVIDER_COVERAGE = "New York, NY, US";
const PROVIDER_DATA_SOURCE = "citybik.es API (https://api.citybik.es/v2/)";

const NOT_SUPPORTED = (op: string) => ({
  accepted: false,
  reason: `NOT_SUPPORTED: Citi Bike NYC is an OBSERVED_ONLY provider. ${op} is not available.`,
});

// ═══════════════════════════════════════════════════════════════════════
// CITI BIKE NYC ADAPTER
// ═══════════════════════════════════════════════════════════════════════

interface CityBikStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  free_bikes: number;
  empty_slots: number;
  extra?: {
    uid?: string;
    renting?: number;
    returning?: number;
    last_updated?: string;
  };
}

interface CityBikNetwork {
  id: string;
  name: string;
  location: { city: string; country: string; latitude: number; longitude: number };
  stations: CityBikStation[];
}

export class CitiBikeNYCProvider implements TransportationProviderAdapter {
  private lastHealthCheck: string | null = null;
  private lastHealthCheckSuccess: boolean = false;
  private lastError: string | null = null;
  private lastLatencyMs: number | null = null;
  private integrationStatus: ProviderIntegrationStatus = "DISABLED";

  // ── IDENTITY ──────────────────────────────────────────────────────

  getProviderIdentity(): ProviderIdentity {
    return {
      providerId: PROVIDER_ID,
      type: "micromobility",
      name: PROVIDER_NAME,
      environment: "OBSERVED_ONLY",
      connectionStatus: this.getConnectionStatus(),
      capabilities: this.getCapabilities(),
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      quotes: false,
      reservation: false,
      dispatch: false,
      tracking: false,
      completion: false,
      payments: false,
    };
  }

  getResources(): TransportationResource[] {
    // Citi Bike doesn't expose vehicle-level resources, only station-level data.
    // We represent each station as a resource.
    return [];
  }

  getConnectionStatus(): ConnectionStatus {
    if (!this.lastHealthCheckSuccess) return "OBSERVED_ONLY";
    return "OBSERVED_ONLY"; // Always OBSERVED_ONLY — this provider cannot execute
  }

  getProvenance(): ProviderProvenance {
    return {
      environment: "OBSERVED_ONLY",
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      coverage: PROVIDER_COVERAGE,
      dataSource: PROVIDER_DATA_SOURCE,
      lastUpdated: this.lastHealthCheck ?? "never",
      executionCapable: false,
      acceptanceCapable: false,
      completionVerificationCapable: false,
    };
  }

  getIntegrationStatus(): ProviderIntegrationStatus {
    return this.integrationStatus;
  }

  setIntegrationStatus(status: ProviderIntegrationStatus): void {
    this.integrationStatus = status;
  }

  // ── HEALTH CHECK ──────────────────────────────────────────────────

  async healthCheck(): Promise<{
    connected: boolean;
    latencyMs: number;
    error: string | null;
    stationCount: number;
    timestamp: string;
  }> {
    const start = Date.now();
    try {
      const response = await fetch(`${CITYBIK_API_BASE}/networks/${CITI_BIKE_NETWORK_ID}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as { network: CityBikNetwork };
      const stationCount = data.network.stations.length;
      const latencyMs = Date.now() - start;

      this.lastHealthCheck = new Date().toISOString();
      this.lastHealthCheckSuccess = true;
      this.lastError = null;
      this.lastLatencyMs = latencyMs;

      if (this.integrationStatus === "DISABLED") {
        this.integrationStatus = "CONNECTED";
      }

      return {
        connected: true,
        latencyMs,
        error: null,
        stationCount,
        timestamp: this.lastHealthCheck,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      this.lastHealthCheck = new Date().toISOString();
      this.lastHealthCheckSuccess = false;
      this.lastError = err?.message || String(err);
      this.lastLatencyMs = latencyMs;

      return {
        connected: false,
        latencyMs,
        error: this.lastError,
        stationCount: 0,
        timestamp: this.lastHealthCheck,
      };
    }
  }

  // ── SUPPLY DISCOVERY ──────────────────────────────────────────────

  async discoverSupply(area: GeoPoint, radiusKm: number): Promise<TransportationSupply[]> {
    if (this.integrationStatus !== "ACTIVE" && this.integrationStatus !== "CONNECTED" && this.integrationStatus !== "READY") {
      // Even in DISABLED state, we allow observation (read-only supply discovery)
      // but NOT acceptance/execution. The integrationStatus gates acceptance.
    }

    try {
      const response = await fetch(`${CITYBIK_API_BASE}/networks/${CITI_BIKE_NETWORK_ID}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        this.lastError = `API returned HTTP ${response.status}`;
        return [];
      }

      const data = (await response.json()) as { network: CityBikNetwork };
      const stations = data.network.stations;

      this.lastHealthCheck = new Date().toISOString();
      this.lastHealthCheckSuccess = true;

      // Filter stations within radiusKm of the requested area
      const supplies: TransportationSupply[] = [];
      const nowSec = Math.floor(Date.now() / 1000) % 86400;

      for (const station of stations) {
        const distance = haversineKm(area, { lat: station.latitude, lon: station.longitude });
        if (distance > radiusKm) continue;

        // Only include stations with bikes available
        const freeBikes = station.free_bikes ?? 0;
        if (freeBikes <= 0) continue;

        const provenance: Provenance = {
          environment: "OBSERVED_ONLY",
          source: "citi-bike-nyc",
          observedAt: station.timestamp || new Date().toISOString(),
          confidence: 0.95, // high confidence — directly observed from provider API
        };

        supplies.push({
          id: `citibike-station-${station.id}`,
          providerId: PROVIDER_ID,
          resourceId: station.id,
          mode: "micromobility",
          capacity: freeBikes + (station.empty_slots ?? 0),
          availableCapacity: freeBikes,
          origin: {
            lat: station.latitude,
            lon: station.longitude,
            name: station.name,
          },
          plannedRoute: [], // bikes don't have planned routes — they're at fixed stations
          plannedStops: [],
          departureWindow: { startSec: nowSec, endSec: nowSec + 3600 },
          availabilityWindow: { startSec: nowSec, endSec: nowSec + 86400 },
          costModel: {
            costPerKm: 0, // Citi Bike pricing is membership/day-pass based, not per-km
            costPerHour: 0,
            fixedCost: 0,
            minimumCompensation: 0,
          },
          detourToleranceKm: 0, // riders must go to the station
          constraints: {
            maxDetourKm: 0, // no detour — rider goes to station
            maxExtraTimeMin: 15, // walking to station
          },
          status: "AVAILABLE",
          source: "citybik-es",
          externalReference: station.id,
          provenance,
        });
      }

      return supplies;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      this.lastHealthCheckSuccess = false;
      return [];
    }
  }

  // ── UNSUPPORTED OPERATIONS (explicit NOT_SUPPORTED) ───────────────

  async quote(request: QuoteRequest): Promise<QuoteResult | null> {
    return null; // NOT_SUPPORTED — Citi Bike has no per-trip pricing API
  }

  async reserve(request: ReserveRequest): Promise<ReserveResult | null> {
    return null; // NOT_SUPPORTED — Citi Bike has no reservation API
  }

  async accept(opportunityId: string): Promise<{ accepted: boolean; reason?: string }> {
    return NOT_SUPPORTED("accept");
  }

  async acceptOffer(offerId: string, idempotencyKey: string): Promise<{ accepted: boolean; providerReference?: string; reason?: string }> {
    return NOT_SUPPORTED("acceptOffer");
  }

  async cancel(opportunityId: string): Promise<{ cancelled: boolean; reason?: string }> {
    return NOT_SUPPORTED("cancel");
  }

  async startExecution(opportunityId: string): Promise<{ started: boolean; executionId?: string }> {
    return { started: false }; // NOT_SUPPORTED
  }

  async getStatus(executionId: string): Promise<ExecutionStatus> {
    return { state: "UNKNOWN", environment: "OBSERVED_ONLY" };
  }

  async verifyCompletion(executionId: string): Promise<{ verified: boolean; completedAt?: string }> {
    return { verified: false }; // NOT_SUPPORTED
  }

  async release(executionId: string): Promise<{ released: boolean }> {
    return { released: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
