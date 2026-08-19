// ORYXX — Real-world transportation observation layer: canonical types.
//
// These are provider-independent, normalized objects. External data sources
// (OSM, GTFS, movement datasets, commercial APIs) map INTO these objects via
// adapters in providers/. The Opportunity Engine consumes only these types,
// never raw provider data — so swapping a fixture for a real feed requires no
// engine changes.
//
// CRITICAL DISTINCTION (prompt §7, §8):
//   ObservedMovement  = "this movement occurred" (LAYER A — empirical)
//   LatentSupply      = "this movement COULD serve another demand" (LAYER B — inferred)
// The conversion from A→B is an explicit, labelled ASSUMPTION, never fact.

import type { Loc } from "../../market/types";

// --- Geographic network -----------------------------------------------------
export interface GeographicNode {
  id: string;
  lat: number;
  lon: number;
  // projected x,y in km for distance math (Mercator-ish, local)
  x: number;
  y: number;
  name?: string;
  kind: "intersection" | "stop" | "station" | "centroid" | "poi";
}

export interface NetworkEdge {
  id: string;
  from: string; // node id
  to: string;
  distanceKm: number;
  // free-flow + typical travel time (minutes), mode-tagged
  walkTimeMin: number;
  driveTimeMin: number;
  modes: ("walk" | "drive" | "transit-access" | "transit-egress")[];
}

export interface RoadCondition {
  edgeId: string;
  // observed/congested travel time (minutes); null if no observation
  observedTimeMin: number | null;
  observedAt: string; // ISO
  source: string;
  confidence: Confidence;
}

// --- Transit (GTFS-normalized) ----------------------------------------------
export interface TransitStop extends GeographicNode {
  code?: string; // agency stop code
  locationType?: "stop" | "station" | "entrance";
  wheelchairBoarding?: boolean;
}

export interface TransitRoute {
  id: string;
  agencyId: string;
  shortName: string;
  longName: string;
  mode: "bus" | "tram" | "metro" | "rail" | "ferry" | "cable_car";
  color?: string;
}

export interface TransitTrip {
  id: string;
  routeId: string;
  serviceId: string;
  headsign: string;
  directionId: 0 | 1;
  // ordered stop times (seconds from midnight)
  stopTimes: { stopId: string; arrivalSec: number; departureSec: number }[];
}

export interface TransitService {
  id: string; // GTFS service_id
  // days of week the service runs
  days: { mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean };
  startDate: string; // YYYYMMDD
  endDate: string;
  exceptions: { date: string; type: "added" | "removed" }[];
}

export interface TransitDeparture {
  routeId: string;
  tripId: string;
  stopId: string;
  routeMode: TransitRoute["mode"];
  routeShortName: string;
  // seconds from midnight, scheduled
  scheduledDepartureSec: number;
  // if GTFS-Realtime available:
  observedDelaySec: number | null;
  observedAt: string | null;
  headsign: string;
}

export interface TransitFeed {
  source: DataSource;
  stops: TransitStop[];
  routes: TransitRoute[];
  trips: TransitTrip[];
  services: TransitService[];
  // coverage
  agencyName: string;
  coverageStart: string;
  coverageEnd: string;
}

// --- Movement / latent supply ----------------------------------------------
export interface ObservedMovement {
  id: string;
  // anonymous — NO personal identifiers
  origin: Loc;
  destination: Loc;
  originNode?: string;
  destNode?: string;
  departureSec: number; // seconds from midnight
  arrivalSec: number;
  // route geometry (polyline of [lat,lon] or projected [x,y]); optional
  path?: Loc[];
  mode: "drive" | "cycle" | "walk";
  // observed vehicle capacity (if known, e.g. taxi fleet record); else null
  observedCapacity: number | null;
  source: DataSource;
  // privacy: true if the record is already anonymized/aggregated by the provider
  anonymized: boolean;
}

// LAYER B — inferred potential supply. Every field that is NOT observed is an
// explicit assumption, surfaced in the UI.
export interface LatentSupply {
  id: string;
  movementId: string; // back-reference to the observed movement
  origin: Loc;
  destination: Loc;
  originNode?: string;
  destNode?: string;
  departureSec: number;
  arrivalSec: number;
  path?: Loc[];
  mode: "drive" | "cycle" | "walk";
  // --- ASSUMPTIONS (not observed) ---
  assumedCapacity: number; // seats that COULD be offered
  assumedWillingness: number; // 0..1 probability the mover would accept a match
  assumedDetourToleranceKm: number;
  assumedMinCompensation: number;
  assumedExecutionProbability: number;
  assumedReliability: number;
  // --- provenance ---
  assumptions: Assumption[];
  source: DataSource;
  tier: OpportunityTier;
}

// --- Supply observation (active/commercial) --------------------------------
export interface SupplyObservation {
  id: string;
  provider: string; // "uber", "bolt", "taxi", "fleet", etc.
  origin: Loc;
  destination?: Loc;
  availableAt: string; // ISO
  capacity: number;
  priceEstimate: number;
  etaMin: number;
  reliability: number;
  source: DataSource;
}

// --- Demand observation -----------------------------------------------------
export interface DemandObservation {
  id: string;
  origin: Loc;
  destination: Loc;
  windowStartSec: number;
  windowEndSec: number;
  partySize: number;
  kind: "person" | "people" | "parcel";
  budget: number;
  value: number;
  source: DataSource;
}

// --- Transportation Opportunity (real-data) --------------------------------
export interface TransportationOpportunity {
  id: string;
  demandId: string;
  supplyId: string; // latent supply id or provider supply id
  origin: Loc;
  destination: Loc;
  departureSec: number;
  arrivalSec: number;
  travelTimeMin: number;
  // baseline (ordinary multimodal) for comparison
  baselineCost: number;
  baselineTimeMin: number;
  baselineMode: string;
  // opportunity economics
  opportunityCost: number;
  estimatedUserSaving: number;
  estimatedSupplierCompensation: number;
  estimatedSocialSurplus: number;
  // detour imposed on the (latent) supplier
  detourKm: number;
  detourMin: number;
  incrementalVehicleKm: number;
  // risk + confidence
  executionProbability: number;
  reliability: number;
  confidence: Confidence;
  tier: OpportunityTier;
  // the critical field: WHY ordinary routing misses this
  reasonOrdinaryWouldMiss: string;
  // whether the opportunity depends on latent-supply info the baseline lacks
  dependsOnLatentSupply: boolean;
  // provenance
  dataSources: DataSource[];
  assumptionSummary: string;
}

// --- Confidence + provenance ------------------------------------------------
export interface Confidence {
  // 0..1 aggregate; decomposed into components below
  overall: number;
  sourceReliability: number;
  dataAgeHours: number;
  spatialPrecisionM: number; // meters of uncertainty
  temporalPrecisionMin: number;
  observedVsInferred: "observed" | "inferred" | "mixed";
  capacityBasis: "observed" | "assumed" | "mixed";
  willingnessBasis: "observed" | "assumed" | "n/a";
  uncertaintyNotes: string[];
}

export interface DataSource {
  name: string;
  type: "osm" | "gtfs" | "gtfs-rt" | "movement" | "weather" | "commercial" | "fixture";
  license: string;
  coveragePeriod: string;
  fetchedAt: string;
  // true if this source is a bundled fixture standing in for a real feed
  isFixture: boolean;
  url?: string;
}

export interface Assumption {
  name: string;
  value: string;
  rationale: string;
  sensitivity: "low" | "medium" | "high";
}

// --- Opportunity quality tiers (prompt §18) --------------------------------
export type OpportunityTier = 0 | 1 | 2 | 3 | 4;
// 0 = observed movement only
// 1 = physically feasible inferred capacity
// 2 = economically attractive inferred opportunity
// 3 = high-confidence opportunity
// 4 = real provider-confirmed capacity (not in this pilot)

// --- Experiment config ------------------------------------------------------
export interface RealExperimentConfig {
  seed: number;
  numDemands: number;
  // movement density multiplier (1.0 = fixture baseline)
  movementDensity: number;
  // future visibility horizon (seconds). 0 = current only.
  planningHorizonSec: number;
  // willingness assumption (0..1)
  willingness: number;
  // detour tolerance assumption (km)
  detourToleranceKm: number;
  // hour-of-day filter (null = all day)
  hourFilter: number | null;
}

export interface OpportunityExperimentResult {
  config: RealExperimentConfig;
  pilot: PilotGeography;
  datasets: DataSource[];
  demands: DemandObservation[];
  movements: ObservedMovement[];
  latentSupply: LatentSupply[];
  opportunities: TransportationOpportunity[];
  baseline: OpportunityBaselineResult;
  // scientific metrics
  metrics: {
    totalDemands: number;
    feasibleOpportunities: number;
    economicallyAttractive: number;
    highConfidence: number;
    opportunitiesPer1000: number;
    medianValue: number;
    p25Value: number;
    p75Value: number;
    totalEstimatedValue: number;
    multimodalRoutingValue: number; // value from transit/bike alone
    latentSupplyDiscoveryValue: number; // value that REQUIRES latent info
    byMode: Record<string, number>;
    byHour: Record<number, number>;
  };
  planningHorizonCurve: { horizonSec: number; opportunities: number; value: number }[];
  densityCurve: { density: number; opportunities: number; value: number }[];
  topOpportunities: TransportationOpportunity[];
  dataQualityWarnings: string[];
  assumptions: Assumption[];
  generatedAt: string;
}

export interface OpportunityBaselineResult {
  name: "Ordinary multimodal routing";
  matchedDemands: number;
  totalDemands: number;
  avgCost: number;
  avgTimeMin: number;
  byMode: Record<string, number>;
}

export interface PilotGeography {
  id: string;
  name: string;
  // bounding box in lat/lon
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  centerLat: number;
  centerLon: number;
  description: string;
  dataSources: string[];
  knownLimitations: string[];
}
