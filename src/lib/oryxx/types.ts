// ORYXX — Core transportation domain types.
// The fundamental primitive is a TRANSPORTATION EVENT:
// "Move X from A to B, subject to constraints, preferences, deadlines,
//  uncertainty, and economic objectives."

// ----------------------------------------------------------------------------
// Object being moved (section 4)
// ----------------------------------------------------------------------------
export type ObjectKind =
  | "person"
  | "people"
  | "parcel"
  | "cargo"
  | "pallet"
  | "container"
  | "vehicle"
  | "materials"
  | "agriculture"
  | "other";

export interface TransportObject {
  kind: ObjectKind;
  label: string; // human label, e.g. "2 people", "10 boxes", "1 TEU container"
  count: number; // units / seats / capacity required
  weightKg?: number;
  fragile?: boolean;
  temperatureControlled?: boolean;
  accessible?: boolean; // accessibility requirement
}

// ----------------------------------------------------------------------------
// Transportation Event (section 4) — the structured intent object
// ----------------------------------------------------------------------------
export type ObjectiveKey =
  | "cost"
  | "time"
  | "reliability"
  | "emissions"
  | "comfort"
  | "transfers"
  | "walking"
  | "safety";

export interface ObjectiveWeights {
  // weights 0..1 each; normalized internally. Default balanced.
  cost: number;
  time: number;
  reliability: number;
  emissions: number;
  comfort: number;
  transfers: number;
  walking: number;
  safety: number;
}

export type RiskTolerance = "risk-averse" | "balanced" | "risk-seeking";

// Autonomy authority (section 22) — how much freedom ORYXX has.
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface Constraints {
  budget?: number; // currency units
  maxTransfers?: number;
  maxWalkingKm?: number;
  requiresAccessibility?: boolean;
  requiresTemperatureControl?: boolean;
  vehicleRequirements?: string[];
}

export interface TransportationEvent {
  object: TransportObject;
  origin: string;
  destination: string;
  earliestDeparture: string; // ISO time or HH:mm
  preferredDeparture?: string;
  latestArrival?: string; // ISO time or HH:mm
  constraints: Constraints;
  objectives: ObjectiveWeights;
  riskTolerance: RiskTolerance;
  autonomy: AutonomyLevel;
  rawIntent?: string; // original NL utterance
}

// ----------------------------------------------------------------------------
// Supply model (section 5) + Latent supply / NPDs (section 6)
// ----------------------------------------------------------------------------
export type Mode =
  | "walk"
  | "bus"
  | "train"
  | "ferry"
  | "rideshare" // Uber/Bolt/taxi — on-demand
  | "carpool" // latent supply / NPD — pre-existing trip with spare capacity
  | "freight"; // truck / courier / fleet

export interface SupplySegment {
  id: string;
  mode: Mode;
  provider: string; // e.g. "Uber", "Bolt", "Metro Line 4", "Commuter NPD #77"
  from: string;
  to: string;
  baseCost: number;
  baseDurationMin: number;
  distanceKm: number;
  reliability: number; // 0..1 probability of running as planned
  emissionsKgCo2e: number;
  comfort: number; // 0..1
  safety: number; // 0..1
  walkingKm: number;
  scheduledDeparture?: string; // HH:mm
  capacitySeats: number;
  isLatentSupply?: boolean; // NPD
  minAcceptableCompensation?: number; // for NPDs / negotiated supply
  dynamicPriceFactor?: number; // demand multiplier on baseCost
  dataFreshnessMin: number;
}

// ----------------------------------------------------------------------------
// Plan / itinerary (section 9, 18, 19)
// ----------------------------------------------------------------------------
export interface ItinerarySegment {
  mode: Mode;
  provider: string;
  from: string;
  to: string;
  depart: string; // HH:mm
  arrive: string; // HH:mm
  durationMin: number;
  cost: number;
  distanceKm: number;
  reliability: number;
  emissionsKgCo2e: number;
  comfort: number;
  safety: number;
  walkingKm: number;
  isLatentSupply: boolean;
  notes?: string;
}

export type PlanTag =
  | "best_overall"
  | "cheapest"
  | "fastest"
  | "most_reliable"
  | "interesting_alternative";

export interface FlexibilityOffer {
  id: string;
  kind: "shift_time" | "allow_transfer" | "share_ride" | "book_earlier" | "wait_watch";
  title: string; // "Leave 25 min later → save $8"
  rationale: string;
  deltaCost: number; // negative = saving
  deltaEtaMin: number; // signed
  newConfidence?: number;
  appliesToPlanId?: string;
}

export interface Plan {
  id: string;
  tag: PlanTag;
  headline: string;
  segments: ItinerarySegment[];
  totalCost: number;
  totalDurationMin: number;
  depart: string;
  arrive: string;
  etaVarianceMin: number;
  onTimeProbability: number; // 0..1 wrt latestArrival
  reliability: number; // 0..1 joint
  emissionsKgCo2e: number;
  transfers: number;
  walkingKm: number;
  comfort: number;
  safety: number;
  score: number; // expected utility 0..1
  confidence: number; // 0..1
  tradeoffNote: string;
  usesLatentSupply: boolean;
}

export interface SolveResponse {
  event: TransportationEvent;
  parsedBy: "llm" | "heuristic" | "structured";
  plans: Plan[];
  flexibilityOffers: FlexibilityOffer[];
  watchEstimate?: { low: number; high: number; hours: number };
  unknowns: string[];
  generatedAt: string;
}

// ----------------------------------------------------------------------------
// Continuous re-optimization feed events (section 20) via socket.io
// ----------------------------------------------------------------------------
export type OptimizationEventKind =
  | "price_drop"
  | "price_surge"
  | "traffic_incident"
  | "new_latent_supply"
  | "eta_update"
  | "cancellation"
  | "reoptimized"
  | "watch_triggered";

export interface OptimizationEvent {
  id: string;
  kind: OptimizationEventKind;
  message: string;
  timestamp: string;
  severity: "info" | "good" | "warn" | "critical";
  reoptimizedPlanId?: string;
  newCost?: number;
  newEta?: string;
  deltaCost?: number;
}
