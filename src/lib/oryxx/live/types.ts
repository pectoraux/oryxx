// ORYXX — Live Transportation Network domain types.
//
// Provider-neutral canonical types for the live marketplace layer. These
// types are SEPARATE from the research instrument (W3-R/W4-R) and from the
// synthetic market simulation. They represent real-world transportation
// demand, supply, opportunities, and execution.
//
// Every object carries explicit provenance (FIXTURE / SANDBOX / LIVE) so
// that sandbox state can never be mistaken for live commerce.
//
// Research isolation: marketplace objects have `isMarketplaceOpportunity`
// set to true and `researchStimulus` set to false. They can NEVER produce
// W3-R/W4-R evidence (research-only tiers). Sandbox execution can NEVER
// produce W3-M/W4-M evidence (marketplace evidence requires LIVE execution
// + independent verification).

// ═══════════════════════════════════════════════════════════════════════
// PROVENANCE
// ═══════════════════════════════════════════════════════════════════════

export type Environment = "FIXTURE" | "SANDBOX" | "LIVE" | "REPLAY" | "LIVE_REAL" | "OBSERVED_ONLY";

export type ProvenanceSource =
  | "direct-user"
  | "shipper"
  | "fleet"
  | "enterprise"
  | "api-client"
  | "gtfs"
  | "gtfs-rt"
  | "osm"
  | "osrm"
  | "sandbox-provider"
  | "fixture-provider"
  | "replay-provider"
  | "oryxx-owned"
  | "observation"
  | "inferred"
  | "assumed"
  | "citybik-es"
  | "citi-bike-nyc";

export interface Provenance {
  environment: Environment;
  source: ProvenanceSource;
  observedAt: string; // ISO timestamp
  validFrom?: string;
  validTo?: string;
  confidence?: number; // 0..1
}

// ═══════════════════════════════════════════════════════════════════════
// GEOGRAPHIC PRIMITIVES (reuse real/types.ts patterns)
// ═══════════════════════════════════════════════════════════════════════

export interface GeoPoint {
  lat: number;
  lon: number;
  name?: string;
}

export interface TimeWindow {
  startSec: number; // seconds from midnight
  endSec: number;
}

// ═══════════════════════════════════════════════════════════════════════
// DEMAND
// ═══════════════════════════════════════════════════════════════════════

export type DemandKind = "person" | "people" | "parcel" | "pallet" | "container";
export type DemandStatus = "OPEN" | "MATCHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "EXPIRED";

export interface TransportationDemand {
  id: string;
  source: ProvenanceSource;
  requestType: "rideshare" | "carpool" | "freight" | "transit-assisted" | "multimodal";
  kind: DemandKind;
  origin: GeoPoint;
  destination: GeoPoint;
  timeWindow: TimeWindow;
  latestArrivalSec: number;
  partySize: number;
  weightKg: number;
  volumeM3: number;
  budget: number; // minor units (cents)
  value: number; // minor units
  priority: "low" | "normal" | "high" | "urgent";
  constraints: {
    maxTransfers?: number;
    maxWalkingKm?: number;
    temperatureControlled?: boolean;
    fragile?: boolean;
    accessible?: boolean;
    vehicleRequirements?: string[];
  };
  status: DemandStatus;
  createdAt: string;
  externalReference?: string;
  userId?: string; // ORYXX account that created it
}

// ═══════════════════════════════════════════════════════════════════════
// SUPPLY
// ═══════════════════════════════════════════════════════════════════════

export type SupplyMode = "rideshare" | "carpool" | "taxi" | "fhv" | "truck" | "transit" | "walking" | "micromobility";
export type SupplyStatus = "AVAILABLE" | "RESERVED" | "COMMITTED" | "EXPIRED" | "OFFLINE";

export interface TransportationResource {
  id: string;
  providerId: string;
  mode: SupplyMode;
  capacity: number;
  vehicleType?: string;
  licensePlate?: string;
  constraints: {
    maxWeightKg?: number;
    maxVolumeM3?: number;
    maxPartySize?: number;
    allowedKinds?: DemandKind[];
  };
}

export interface TransportationSupply {
  id: string;
  providerId: string;
  resourceId: string;
  mode: SupplyMode;
  capacity: number;
  availableCapacity: number;
  origin: GeoPoint;
  currentLocation?: GeoPoint;
  plannedRoute: GeoPoint[];
  plannedStops: GeoPoint[];
  departureWindow: TimeWindow;
  availabilityWindow: TimeWindow;
  costModel: {
    costPerKm: number; // minor units
    costPerHour: number;
    fixedCost: number;
    minimumCompensation: number;
  };
  detourToleranceKm: number;
  constraints: {
    maxDetourKm: number;
    maxExtraTimeMin: number;
  };
  status: SupplyStatus;
  source: ProvenanceSource;
  externalReference?: string;
  provenance: Provenance;
}

// ═══════════════════════════════════════════════════════════════════════
// OPPORTUNITY (live marketplace — NOT a research stimulus)
// ═══════════════════════════════════════════════════════════════════════

export type OpportunityStatus =
  | "DISCOVERED"
  | "EVALUATED"
  | "OFFERED"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "RESERVED"
  | "DISPATCHED"
  | "EN_ROUTE"
  | "PICKED_UP"
  | "EXECUTING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "NO_SHOW"
  | "UNFULFILLED";

export interface TransportationOpportunity {
  id: string;
  demandId: string;
  supplyId: string;
  providerId: string;
  route: {
    pickup: GeoPoint;
    dropoff: GeoPoint;
    waypoints: GeoPoint[];
    distanceKm: number;
    estimatedTimeMin: number;
  };
  departure: TimeWindow;
  arrival: TimeWindow;
  detourKm: number;
  extraTimeMin: number;
  capacityUsed: number;
  price: number; // minor units — user price
  supplierCompensation: number; // minor units
  platformFee: number; // minor units
  executionProbability: number; // 0..1
  confidence: number; // 0..1
  provenance: Provenance;
  status: OpportunityStatus;
  whyFeasible: string;
  whyNow: string;
  whyThisSupply: string;
  whyOrdinaryRoutingMissesIt: string;
  isMarketplaceOpportunity: true; // ALWAYS true for marketplace
  researchStimulus: false; // ALWAYS false for marketplace
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER
// ═══════════════════════════════════════════════════════════════════════

export type ProviderType =
  | "rideshare"
  | "taxi"
  | "fhv"
  | "truck"
  | "fleet"
  | "transit"
  | "micromobility"
  | "oryxx-owned"
  | "private-driver";

export type ConnectionStatus = "CONNECTED" | "NOT_CONNECTED" | "SANDBOX_ACTIVE" | "FIXTURE_ONLY" | "ERROR" | "OBSERVED_ONLY";

// Provider integration lifecycle for real providers
export type ProviderIntegrationStatus =
  | "DISABLED"      // not configured
  | "CONNECTED"     // API reachable, health check passed
  | "VALIDATED"      // test data confirmed
  | "READY"          // operator-validated, ready for activation
  | "ACTIVE"         // accepting real marketplace operations
  | "PAUSED";        // temporarily deactivated by operator

// Provider provenance classification
export interface ProviderProvenance {
  environment: Environment;
  providerId: string;
  providerName: string;
  coverage: string;          // e.g., "New York, NY"
  dataSource: string;        // e.g., "citybik.es API"
  lastUpdated: string;        // ISO timestamp of last successful API call
  executionCapable: boolean;  // can the provider actually execute trips?
  acceptanceCapable: boolean; // can the provider accept/reject offers?
  completionVerificationCapable: boolean; // can the provider verify completion?
}

export interface ProviderCapabilities {
  quotes: boolean;
  reservation: boolean;
  dispatch: boolean;
  tracking: boolean;
  completion: boolean;
  payments: boolean;
}

export interface ProviderIdentity {
  providerId: string;
  type: ProviderType;
  name: string;
  environment: Environment;
  connectionStatus: ConnectionStatus;
  capabilities: ProviderCapabilities;
  externalReference?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// OFFER + AGREEMENT
// ═══════════════════════════════════════════════════════════════════════

export interface MarketplaceOffer {
  id: string;
  opportunityId: string;
  demandId: string;
  supplyId: string;
  providerId: string;
  userPrice: number; // minor units
  supplierCompensation: number;
  platformFee: number;
  expiresAt: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  provenance: Provenance;
  isMarketplaceOpportunity: true;
  researchStimulus: false;
  createdAt: string;
}

export interface MarketplaceAgreement {
  id: string;
  offerId: string;
  opportunityId: string;
  demandId: string;
  supplyId: string;
  providerId: string;
  agreedPrice: number; // minor units
  supplierCompensation: number;
  platformFee: number;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "BREACHED";
  provenance: Provenance;
  isMarketplaceOpportunity: true;
  researchStimulus: false;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTION
// ═══════════════════════════════════════════════════════════════════════

export type ExecutionState =
  | "OPPORTUNITY_CREATED"
  | "OFFERED"
  | "ACCEPTED"
  | "RESERVED"
  | "DISPATCHED"
  | "EN_ROUTE"
  | "PICKED_UP"
  | "EXECUTING"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED"
  | "NO_SHOW"
  | "UNFULFILLED";

export interface TransportationExecution {
  id: string;
  agreementId: string;
  opportunityId: string;
  demandId: string;
  supplyId: string;
  providerId: string;
  state: ExecutionState;
  environment: Environment;
  // Marketplace evidence: only LIVE execution + independent verification → W4-M
  // Sandbox execution NEVER produces W3-M/W4-M
  evidenceEligible: boolean; // false for SANDBOX/FIXTURE
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  provenance: Provenance;
  isMarketplaceOpportunity: true;
  researchStimulus: false;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// AVAILABILITY BROADCAST (NPD / latent supply)
// ═══════════════════════════════════════════════════════════════════════

export type BroadcastStatus = "POTENTIAL" | "OFFERED" | "RESERVED" | "COMMITTED" | "EXPIRED";

export interface AvailabilityBroadcast {
  id: string;
  providerId: string;
  resourceId: string;
  currentLocation: GeoPoint;
  destination: GeoPoint;
  departureWindow: TimeWindow;
  availableCapacity: number;
  detourToleranceKm: number;
  minimumCompensation: number; // minor units
  confidence: number; // 0..1
  expiresAt: string;
  status: BroadcastStatus;
  provenance: Provenance;
  // Only COMMITTED supply can be used in guaranteed execution
  isCommitted: boolean;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// NEGOTIATION + AUCTIONS
// ═══════════════════════════════════════════════════════════════════════

export type NegotiationType =
  | "fixed-price"
  | "take-it-or-leave-it"
  | "bounded-bargaining"
  | "reverse-auction"
  | "sealed-offer";

export type NegotiationState = "OPEN" | "COUNTERED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "SETTLED";

export interface NegotiationRound {
  round: number;
  proposer: "buyer" | "supplier" | "oryxx";
  price: number; // minor units
  timestamp: string;
  reason?: string;
}

export interface Negotiation {
  id: string;
  opportunityId: string;
  demandId: string;
  supplyId: string;
  type: NegotiationType;
  minimumPrice: number; // supplier reservation
  maximumPrice: number; // buyer budget
  reservationPrice: number; // computed midpoint or ORYXX-determined
  deadline: string;
  rounds: NegotiationRound[];
  state: NegotiationState;
  finalPrice?: number;
  provenance: Provenance;
  isMarketplaceOpportunity: true;
  researchStimulus: false;
  createdAt: string;
}

export type AuctionType = "lowest-feasible-price" | "highest-supplier-surplus" | "welfare-maximizing";

export interface AuctionBid {
  auctionId: string;
  supplyId: string;
  providerId: string;
  price: number; // minor units
  timestamp: string;
  rank?: number;
}

export interface Auction {
  id: string;
  demandId: string;
  type: AuctionType;
  eligibleSupplyIds: string[];
  startAt: string;
  endAt: string;
  minimumPrice: number;
  maximumPrice: number;
  bids: AuctionBid[];
  winnerSupplyId?: string;
  clearingPrice?: number;
  reason?: string;
  state: "OPEN" | "CLOSED" | "AWARDED" | "CANCELLED";
  provenance: Provenance;
  isMarketplaceOpportunity: true;
  researchStimulus: false;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// MONEY LEDGER (double-entry, integer minor units)
// ═══════════════════════════════════════════════════════════════════════

export type AccountType =
  | "customer"
  | "escrow"
  | "supplier"
  | "platform-revenue"
  | "platform-sandbox";

export interface MoneyAccount {
  id: string;
  ownerId: string; // user ID, provider ID, or "oryxx-platform"
  type: AccountType;
  currency: string; // ISO 4217
  balance: number; // integer minor units
  environment: Environment;
  frozen: boolean;
  createdAt: string;
}

export type LedgerEntryType =
  | "DEBIT"
  | "CREDIT";

export interface LedgerEntry {
  id: string;
  accountId: string;
  type: LedgerEntryType;
  amount: number; // positive integer minor units
  currency: string;
  description: string;
  referenceType: "demand" | "opportunity" | "agreement" | "execution" | "payment-intent" | "settlement" | "refund" | "adjustment";
  referenceId: string;
  idempotencyKey: string; // every entry must have a unique key
  pairedEntryId: string; // double-entry: the matching opposite entry
  environment: Environment;
  timestamp: string;
}

export type PaymentIntentStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "CAPTURED"
  | "RELEASED"
  | "REFUNDED"
  | "FAILED";

export interface PaymentIntent {
  id: string;
  demandId: string;
  agreementId?: string;
  executionId?: string;
  customerId: string;
  supplierId: string;
  amount: number; // total in minor units
  userPrice: number;
  supplierCompensation: number;
  platformFee: number;
  currency: string;
  status: PaymentIntentStatus;
  idempotencyKey: string;
  authorizationId?: string;
  captureId?: string;
  refundId?: string;
  environment: Environment;
  createdAt: string;
  capturedAt?: string;
}

export interface Settlement {
  id: string;
  executionId: string;
  supplierId: string;
  amount: number; // minor units
  currency: string;
  status: "PENDING" | "SETTLED" | "FAILED";
  idempotencyKey: string;
  environment: Environment;
  settledAt?: string;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// AGENTS
// ═══════════════════════════════════════════════════════════════════════

export type AgentRole = "rider" | "shipper" | "supplier" | "fleet" | "oryxx";
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5; // L0-L5

export interface Agent {
  id: string;
  ownerId: string;
  role: AgentRole;
  objectiveWeights: {
    cost?: number;
    time?: number;
    reliability?: number;
    emissions?: number;
    comfort?: number;
    safety?: number;
    earnings?: number;
    utilization?: number;
    welfare?: number;
  };
  constraints: {
    budget?: number;
    maxDelayMin?: number;
    riskTolerance?: "risk-averse" | "balanced" | "risk-seeking";
    minimumCompensation?: number;
    maxAutonomyLevel: AutonomyLevel;
  };
  availability?: TimeWindow;
  isAutoEnabled: boolean;
  provenance: Provenance;
  createdAt: string;
}

export interface AgentDecision {
  id: string;
  agentId: string;
  decisionType: "discover" | "rank" | "bid" | "counteroffer" | "reserve" | "accept" | "reject" | "execute";
  targetId: string; // opportunityId, demandId, etc.
  autonomyLevel: AutonomyLevel;
  reasoning: string;
  constraints: Record<string, any>;
  authorized: boolean; // was this within the agent's autonomy bounds?
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL TRANSPORTATION GRAPH
// ═══════════════════════════════════════════════════════════════════════

export type GraphNodeType = "region" | "city" | "zone" | "stop" | "hub" | "depot" | "terminal" | "intersection";
export type EdgeType = "road" | "transit" | "walking" | "freight-route" | "transfer";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  point: GeoPoint;
  name?: string;
  source: ProvenanceSource;
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  confidence: number;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: EdgeType;
  distanceKm: number;
  travelTimeSec: number;
  source: ProvenanceSource;
  observedAt: string;
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVATIONS (crowd-sourced world model)
// ═══════════════════════════════════════════════════════════════════════

export type ObservationType =
  | "traffic"
  | "road-closure"
  | "vehicle-availability"
  | "unsafe-zone"
  | "transit-disruption"
  | "parking"
  | "loading-zone";

export type ObservationBasis = "OBSERVED" | "REPORTED" | "INFERRED" | "ASSUMED";

export interface Observation {
  id: string;
  source: ProvenanceSource;
  observer: string; // user ID, provider ID, sensor ID
  timestamp: string;
  location: GeoPoint;
  type: ObservationType;
  basis: ObservationBasis;
  confidence: number;
  payload: Record<string, any>;
}

// ═══════════════════════════════════════════════════════════════════════
// CIVIC CONTRIBUTIONS
// ═══════════════════════════════════════════════════════════════════════

export type ContributionType =
  | "road-observation"
  | "traffic-report"
  | "transit-update"
  | "verified-supply-signal"
  | "data-correction"
  | "safety-report";

export interface CivicContribution {
  id: string;
  userId: string;
  type: ContributionType;
  observationId?: string;
  points: number; // non-monetary, anti-gaming
  verified: boolean;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// MARKETPLACE EVIDENCE BOUNDARY
// ═══════════════════════════════════════════════════════════════════════

// W3-M = marketplace acceptance (ACCEPTED state, LIVE environment only)
// W4-M = marketplace completion (COMPLETED + independent verification, LIVE only)
// Sandbox/Fixture execution can NEVER produce W3-M/W4-M.
// Research stimuli can NEVER produce W3-M/W4-M.

export const MARKETPLACE_EVIDENCE_RULES = {
  // W3-M: marketplace acceptance
  w3mRequires: ["LIVE", "ACCEPTED"] as const,
  // W4-M: marketplace completion
  w4mRequires: ["LIVE", "COMPLETED", "INDEPENDENT_VERIFICATION"] as const,
  // Sandbox/fixture explicitly excluded
  sandboxCannotProduce: ["W3-M", "W4-M"] as const,
  // Research stimuli explicitly excluded
  researchStimulusCannotProduce: ["W3-M", "W4-M"] as const,
} as const;

export function canProduceMarketplaceEvidence(
  execution: TransportationExecution,
): { w3m: boolean; w4m: boolean; reason: string } {
  if (execution.environment !== "LIVE") {
    return {
      w3m: false,
      w4m: false,
      reason: `${execution.environment} execution cannot produce W3-M/W4-M`,
    };
  }
  if (!execution.evidenceEligible) {
    return { w3m: false, w4m: false, reason: "execution not evidence-eligible" };
  }
  const w3m = ["ACCEPTED", "RESERVED", "DISPATCHED", "EN_ROUTE", "PICKED_UP", "EXECUTING", "COMPLETED"].includes(execution.state);
  const w4m = execution.state === "COMPLETED";
  return {
    w3m,
    w4m,
    reason: w4m ? "W4-M: LIVE COMPLETED execution" : w3m ? "W3-M: LIVE ACCEPTED execution" : `state ${execution.state} not evidence-eligible`,
  };
}
