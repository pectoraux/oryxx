// ORYXX — Sandbox Transportation Provider
//
// A deterministic sandbox provider that behaves like a real provider interface
// but uses fixture data. All state is labeled environment = "SANDBOX".
// Sandbox transactions NEVER produce W3-M/W4-M evidence.
//
// This is the first provider to be registered — it allows the full marketplace
// pipeline to work end-to-end without real API credentials.

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
} from "../types";
import type {
  TransportationProviderAdapter,
  QuoteRequest,
  QuoteResult,
  ReserveRequest,
  ReserveResult,
  ExecutionStatus,
} from "./provider-registry";

const SANDBOX_PROVENANCE: Provenance = {
  environment: "SANDBOX",
  source: "sandbox-provider",
  observedAt: new Date().toISOString(),
  confidence: 1.0,
};

let supplyCounter = 0;
let executionCounter = 0;
const executions = new Map<string, ExecutionStatus>();

export class SandboxTransportationProvider implements TransportationProviderAdapter {
  private resources: TransportationResource[];

  constructor(
    private providerId: string = "sandbox-rideshare",
    private name: string = "Sandbox Rideshare",
    private type: ProviderType = "rideshare",
  ) {
    this.resources = [
      {
        id: "sandbox-vehicle-1",
        providerId: this.providerId,
        mode: "rideshare",
        capacity: 4,
        vehicleType: "sedan",
        constraints: { maxPartySize: 4, allowedKinds: ["person", "people"] },
      },
      {
        id: "sandbox-vehicle-2",
        providerId: this.providerId,
        mode: "rideshare",
        capacity: 6,
        vehicleType: "suv",
        constraints: { maxPartySize: 6, allowedKinds: ["person", "people"] },
      },
    ];
  }

  getProviderIdentity(): ProviderIdentity {
    return {
      providerId: this.providerId,
      type: this.type,
      name: this.name,
      environment: "SANDBOX",
      connectionStatus: "SANDBOX_ACTIVE",
      capabilities: this.getCapabilities(),
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      quotes: true,
      reservation: true,
      dispatch: true,
      tracking: true,
      completion: true,
      payments: false, // sandbox payments handled by SandboxPaymentProvider
    };
  }

  getResources(): TransportationResource[] {
    return [...this.resources];
  }

  getConnectionStatus(): ConnectionStatus {
    return "SANDBOX_ACTIVE";
  }

  async discoverSupply(area: GeoPoint, radiusKm: number): Promise<TransportationSupply[]> {
    // Generate deterministic sandbox supply near the requested area
    supplyCounter++;
    const id = `sandbox-supply-${supplyCounter}`;
    const now = new Date();
    const startSec = Math.floor(now.getTime() / 1000) % 86400;
    const supply: TransportationSupply = {
      id,
      providerId: this.providerId,
      resourceId: this.resources[0].id,
      mode: "rideshare",
      capacity: 4,
      availableCapacity: 4,
      origin: { lat: area.lat + 0.01, lon: area.lon + 0.01, name: "Sandbox Pickup" },
      currentLocation: { lat: area.lat, lon: area.lon },
      plannedRoute: [{ lat: area.lat, lon: area.lon }, { lat: area.lat + 0.05, lon: area.lon + 0.05 }],
      plannedStops: [{ lat: area.lat + 0.05, lon: area.lon + 0.05 }],
      departureWindow: { startSec, endSec: startSec + 3600 },
      availabilityWindow: { startSec, endSec: startSec + 7200 },
      costModel: {
        costPerKm: 150, // $1.50/km in minor units
        costPerHour: 3000, // $30/hr
        fixedCost: 200, // $2.00 base
        minimumCompensation: 500, // $5.00 min
      },
      detourToleranceKm: 3,
      constraints: { maxDetourKm: 5, maxExtraTimeMin: 20 },
      status: "AVAILABLE",
      source: "sandbox-provider",
      provenance: SANDBOX_PROVENANCE,
    };
    return [supply];
  }

  async quote(request: QuoteRequest): Promise<QuoteResult | null> {
    const { demand, supply } = request;
    // Simple distance-based pricing
    const distKm = haversineKm(demand.origin, demand.destination);
    const timeMin = Math.max(5, distKm / 40 * 60); // 40 km/h avg
    const price = supply.costModel.fixedCost + distKm * supply.costModel.costPerKm + (timeMin / 60) * supply.costModel.costPerHour;
    return {
      price: Math.round(price),
      estimatedTimeMin: Math.round(timeMin),
      estimatedDistanceKm: Math.round(distKm * 100) / 100,
      executionProbability: 0.9,
      validUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      environment: "SANDBOX",
    };
  }

  async reserve(request: ReserveRequest): Promise<ReserveResult | null> {
    return {
      reservationId: `sandbox-reservation-${Date.now()}`,
      status: "RESERVED",
      expiresAt: request.expiresAt,
      environment: "SANDBOX",
    };
  }

  async accept(opportunityId: string): Promise<{ accepted: boolean; reason?: string }> {
    return { accepted: true };
  }

  async cancel(opportunityId: string): Promise<{ cancelled: boolean; reason?: string }> {
    return { cancelled: true };
  }

  async startExecution(opportunityId: string): Promise<{ started: boolean; executionId?: string }> {
    executionCounter++;
    const execId = `sandbox-exec-${executionCounter}`;
    executions.set(execId, {
      state: "EN_ROUTE",
      location: { lat: 0, lon: 0 },
      eta: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      environment: "SANDBOX",
    });
    return { started: true, executionId: execId };
  }

  async getStatus(executionId: string): Promise<ExecutionStatus> {
    const status = executions.get(executionId);
    if (!status) {
      return { state: "UNKNOWN", environment: "SANDBOX" };
    }
    // Simulate progress: EN_ROUTE → PICKED_UP → COMPLETED
    if (status.state === "EN_ROUTE") {
      const updated = { ...status, state: "PICKED_UP" };
      executions.set(executionId, updated);
      return updated;
    }
    if (status.state === "PICKED_UP") {
      const updated = {
        ...status,
        state: "COMPLETED",
        completedAt: new Date().toISOString(),
      };
      executions.set(executionId, updated);
      return updated;
    }
    return status;
  }

  async verifyCompletion(executionId: string): Promise<{ verified: boolean; completedAt?: string }> {
    const status = executions.get(executionId);
    if (status?.state === "COMPLETED" && status.completedAt) {
      return { verified: true, completedAt: status.completedAt };
    }
    return { verified: false };
  }

  async release(executionId: string): Promise<{ released: boolean }> {
    executions.delete(executionId);
    return { released: true };
  }
}

// Haversine distance (km)
function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
