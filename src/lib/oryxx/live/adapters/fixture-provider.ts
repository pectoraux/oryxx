// ORYXX — Fixture Transportation Provider
//
// A deterministic fixture provider that returns canned data. Used for testing
// and development. All state is labeled environment = "FIXTURE". Fixture
// transactions NEVER produce W3-M/W4-M evidence.

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
} from "../types";
import type {
  TransportationProviderAdapter,
  QuoteRequest,
  QuoteResult,
  ReserveRequest,
  ReserveResult,
  ExecutionStatus,
} from "./provider-registry";

const FIXTURE_PROVENANCE: Provenance = {
  environment: "FIXTURE",
  source: "fixture-provider",
  observedAt: new Date().toISOString(),
  confidence: 1.0,
};

export class FixtureTransportationProvider implements TransportationProviderAdapter {
  constructor(
    private providerId: string = "fixture-transit",
    private name: string = "Fixture Transit (GTFS)",
    private type: ProviderType = "transit",
  ) {}

  getProviderIdentity(): ProviderIdentity {
    return {
      providerId: this.providerId,
      type: this.type,
      name: this.name,
      environment: "FIXTURE",
      connectionStatus: "FIXTURE_ONLY",
      capabilities: this.getCapabilities(),
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      quotes: true,
      reservation: false, // transit doesn't accept reservations
      dispatch: false,
      tracking: true,
      completion: true,
      payments: false,
    };
  }

  getConnectionStatus(): ConnectionStatus {
    return "FIXTURE_ONLY";
  }

  getResources(): TransportationResource[] {
    return [
      {
        id: "fixture-bus-1",
        providerId: this.providerId,
        mode: "transit",
        capacity: 40,
        vehicleType: "bus",
        constraints: { maxPartySize: 40, allowedKinds: ["person", "people"] },
      },
    ];
  }

  async discoverSupply(area: GeoPoint, radiusKm: number): Promise<TransportationSupply[]> {
    const startSec = 8 * 3600; // 08:00
    return [
      {
        id: `fixture-transit-supply-1`,
        providerId: this.providerId,
        resourceId: "fixture-bus-1",
        mode: "transit",
        capacity: 40,
        availableCapacity: 20,
        origin: { lat: area.lat, lon: area.lon, name: "Fixture Transit Stop" },
        plannedRoute: [
          { lat: area.lat, lon: area.lon },
          { lat: area.lat + 0.1, lon: area.lon + 0.1 },
        ],
        plannedStops: [{ lat: area.lat + 0.1, lon: area.lon + 0.1 }],
        departureWindow: { startSec, endSec: startSec + 1800 },
        availabilityWindow: { startSec, endSec: startSec + 86400 },
        costModel: {
          costPerKm: 50, // $0.50/km
          costPerHour: 0,
          fixedCost: 250, // $2.50 base fare
          minimumCompensation: 250,
        },
        detourToleranceKm: 0,
        constraints: { maxDetourKm: 0, maxExtraTimeMin: 60 },
        status: "AVAILABLE",
        source: "fixture-provider",
        provenance: FIXTURE_PROVENANCE,
      },
    ];
  }

  async quote(request: QuoteRequest): Promise<QuoteResult | null> {
    const { demand } = request;
    const distKm = haversineKm(demand.origin, demand.destination);
    return {
      price: 250, // flat $2.50 fare
      estimatedTimeMin: Math.round(distKm / 25 * 60), // 25 km/h avg for transit
      estimatedDistanceKm: Math.round(distKm * 100) / 100,
      executionProbability: 0.85,
      validUntil: new Date(Date.now() + 60 * 1000).toISOString(),
      environment: "FIXTURE",
    };
  }

  async reserve(request: ReserveRequest): Promise<ReserveResult | null> {
    return null; // transit doesn't accept reservations
  }

  async accept(opportunityId: string): Promise<{ accepted: boolean; reason?: string }> {
    return { accepted: false, reason: "Fixture transit does not accept individual reservations" };
  }

  async cancel(opportunityId: string): Promise<{ cancelled: boolean; reason?: string }> {
    return { cancelled: true };
  }

  async startExecution(opportunityId: string): Promise<{ started: boolean; executionId?: string }> {
    return { started: false, reason: "Transit is scheduled, not dispatched" };
  }

  async getStatus(executionId: string): Promise<ExecutionStatus> {
    return { state: "SCHEDULED", environment: "FIXTURE" };
  }

  async verifyCompletion(executionId: string): Promise<{ verified: boolean; completedAt?: string }> {
    return { verified: false };
  }

  async release(executionId: string): Promise<{ released: boolean }> {
    return { released: true };
  }
}

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
