// ORYXX — Provider Adapter Interface + Registry
//
// Provider-neutral adapter contract for transportation supply providers.
// Every adapter declares its environment (LIVE / SANDBOX / FIXTURE / REPLAY)
// and its capabilities. The core engine never depends on a specific provider.
//
// Where real API credentials are unavailable, adapters return NOT_CONNECTED
// (not fake live data). The registry reports connection status explicitly.

import type {
  Environment,
  GeoPoint,
  ProviderCapabilities,
  ProviderIdentity,
  ProviderType,
  Provenance,
  TransportationDemand,
  TransportationResource,
  TransportationSupply,
  ConnectionStatus,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER ADAPTER INTERFACE
// ═══════════════════════════════════════════════════════════════════════

export interface QuoteRequest {
  demand: TransportationDemand;
  supply: TransportationSupply;
}

export interface QuoteResult {
  price: number; // minor units
  estimatedTimeMin: number;
  estimatedDistanceKm: number;
  executionProbability: number;
  validUntil: string;
  environment: Environment;
}

export interface ReserveRequest {
  opportunityId: string;
  demandId: string;
  supplyId: string;
  expiresAt: string;
}

export interface ReserveResult {
  reservationId: string;
  status: "RESERVED" | "FAILED";
  expiresAt: string;
  environment: Environment;
}

export interface ExecutionStatus {
  state: string;
  location?: GeoPoint;
  eta?: string;
  completedAt?: string;
  failureReason?: string;
  environment: Environment;
}

export interface TransportationProviderAdapter {
  // Identity
  getProviderIdentity(): ProviderIdentity;
  getCapabilities(): ProviderCapabilities;
  getResources(): TransportationResource[];

  // Supply discovery
  discoverSupply(area: GeoPoint, radiusKm: number): Promise<TransportationSupply[]>;

  // Quote / pricing
  quote(request: QuoteRequest): Promise<QuoteResult | null>;

  // Reservation
  reserve(request: ReserveRequest): Promise<ReserveResult | null>;

  // Accept / cancel — idempotent with idempotencyKey
  accept(opportunityId: string): Promise<{ accepted: boolean; reason?: string }>;
  acceptOffer(offerId: string, idempotencyKey: string): Promise<{ accepted: boolean; providerReference?: string; reason?: string }>;
  cancel(opportunityId: string): Promise<{ cancelled: boolean; reason?: string }>;

  // Execution lifecycle
  startExecution(opportunityId: string): Promise<{ started: boolean; executionId?: string }>;
  getStatus(executionId: string): Promise<ExecutionStatus>;
  verifyCompletion(executionId: string): Promise<{ verified: boolean; completedAt?: string }>;
  release(executionId: string): Promise<{ released: boolean }>;

  // Connection status
  getConnectionStatus(): ConnectionStatus;
}

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER REGISTRY
// ═══════════════════════════════════════════════════════════════════════

class ProviderRegistry {
  private adapters = new Map<string, TransportationProviderAdapter>();

  register(adapter: TransportationProviderAdapter): void {
    const id = adapter.getProviderIdentity().providerId;
    if (this.adapters.has(id)) {
      throw new Error(`Provider ${id} already registered`);
    }
    this.adapters.set(id, adapter);
  }

  get(providerId: string): TransportationProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  getAll(): TransportationProviderAdapter[] {
    return [...this.adapters.values()];
  }

  getIdentities(): ProviderIdentity[] {
    return this.getAll().map((a) => a.getProviderIdentity());
  }

  getByType(type: ProviderType): TransportationProviderAdapter[] {
    return this.getAll().filter((a) => a.getProviderIdentity().type === type);
  }

  getByEnvironment(env: Environment): TransportationProviderAdapter[] {
    return this.getAll().filter((a) => a.getProviderIdentity().environment === env);
  }

  getConnected(): TransportationProviderAdapter[] {
    return this.getAll().filter((a) => {
      const status = a.getConnectionStatus();
      return status === "CONNECTED" || status === "SANDBOX_ACTIVE";
    });
  }

  // Report all providers with their connection status (for UI / API)
  status(): Array<{
    identity: ProviderIdentity;
    capabilities: ProviderCapabilities;
    connectionStatus: ConnectionStatus;
    resourceCount: number;
  }> {
    return this.getAll().map((a) => ({
      identity: a.getProviderIdentity(),
      capabilities: a.getCapabilities(),
      connectionStatus: a.getConnectionStatus(),
      resourceCount: a.getResources().length,
    }));
  }

  // Discover supply from all connected providers in an area
  async discoverAllSupply(area: GeoPoint, radiusKm: number): Promise<TransportationSupply[]> {
    const connected = this.getConnected();
    const results = await Promise.allSettled(
      connected.map((a) => a.discoverSupply(area, radiusKm)),
    );
    const supplies: TransportationSupply[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) supplies.push(...r.value);
    }
    return supplies;
  }

  clear(): void {
    this.adapters.clear();
  }
}

// Singleton registry
export const providerRegistry = new ProviderRegistry();

// ═══════════════════════════════════════════════════════════════════════
// DEMAND SOURCE ADAPTER INTERFACE
// ═══════════════════════════════════════════════════════════════════════

export interface DemandSourceAdapter {
  source: string;
  ingestRequest(raw: any): Promise<TransportationDemand>;
  updateRequest(id: string, updates: any): Promise<TransportationDemand | null>;
  cancelRequest(id: string): Promise<boolean>;
  getStatus(id: string): Promise<{ status: string; updates: any[] } | null>;
}

class DemandSourceRegistry {
  private sources = new Map<string, DemandSourceAdapter>();

  register(adapter: DemandSourceAdapter): void {
    if (this.sources.has(adapter.source)) {
      throw new Error(`Demand source ${adapter.source} already registered`);
    }
    this.sources.set(adapter.source, adapter);
  }

  get(source: string): DemandSourceAdapter | undefined {
    return this.sources.get(source);
  }

  getAll(): DemandSourceAdapter[] {
    return [...this.sources.values()];
  }

  getSources(): string[] {
    return [...this.sources.keys()];
  }
}

export const demandSourceRegistry = new DemandSourceRegistry();
