// ORYXX — Canonical transportation experiment types.
//
// This module is the methodological foundation. Every strategy (ordinary,
// centralized, ORYXX, clairvoyant) MUST use TransportationEvaluation and the
// shared feasibility/welfare primitives. No strategy may define its own
// welfare formula. This is what makes the comparison scientifically valid.
//
// Reviewer mandate: "Do not duplicate economic logic across mechanisms."

import type { Loc } from "../types";

// --- World configuration (assumptions, NOT empirical facts) ----------------
// All empty-km / behavioural assumptions live here as explicit, configurable
// parameters. The UI MUST label these as ASSUMPTIONS, never as real-world facts.
export interface WorldConfig {
  // behavioural assumptions for empty-km accounting
  deadheadRatioRideshare: number; // fraction of trip km a rideshare deadheads back
  deadheadRatioTruck: number; // fraction of trip km a truck deadheads back
  repositionRatioAfterDrop: number; // fraction of trip km a matched driver repositions
  committedTripExecutesIfUnmatched: boolean; // committed supply drives anyway (empty)
  npdActivatesIfUnmatched: boolean; // potential NPD trip happens even if unmatched
  transitRunsRegardless: boolean; // transit operates its schedule regardless of load
  // economics
  speedKmh: number;
  // welfare
  reliabilityWeight: number; // 0..1 — how much reliability factors into risk adjustment
  // planning horizon (minutes). 0 = no future visibility.
  planningHorizonMin: number;
  // pooling / detour defaults (can be overridden per demand/supply)
  defaultDetourToleranceKm: number;
}

export const DEFAULT_WORLD: WorldConfig = {
  deadheadRatioRideshare: 0.7,
  deadheadRatioTruck: 0.6,
  repositionRatioAfterDrop: 0.25,
  committedTripExecutesIfUnmatched: true,
  npdActivatesIfUnmatched: false, // potential NPDs only drive if matched — the latent-supply saving
  transitRunsRegardless: true,
  speedKmh: 38,
  reliabilityWeight: 0.4,
  planningHorizonMin: 0,
  defaultDetourToleranceKm: 2.5,
};

// --- Canonical evaluation primitive -----------------------------------------
// One object, computed identically for every strategy. Contains ALL the
// economic + physical quantities needed to compare mechanisms fairly.
export interface TransportationEvaluation {
  demandId: string;
  supplyId: string;
  feasible: boolean;
  reasonIfInfeasible?: string;
  // timing
  departure: number; // minutes from midnight
  arrival: number;
  travelTimeMin: number;
  // distance accounting
  directDistanceKm: number; // demand origin -> destination
  operationalVehicleKm: number; // km the vehicle actually drives for this match
  emptyVehicleKm: number; // km driven with no payload attributable to this match
  detourKm: number; // extra km vs the supply's direct route
  // economics — REAL quantities (price is a transfer, not real value)
  supplierCost: number; // real cost to the supplier (fuel + wear + time)
  userMaxPrice: number; // demand.budget
  reservationPrice: number; // supplier.minCompensation
  price: number; // negotiated transfer price
  userSurplus: number; // value - price  (value = willingness to pay)
  supplierSurplus: number; // price - supplierCost
  socialSurplus: number; // userSurplus + supplierSurplus  (price cancels — no fake value)
  // risk
  executionProbability: number; // 0..1
  reliability: number; // 0..1
  riskAdjustedWelfare: number; // socialSurplus * execProb * (reliabilityWeight + (1-reliabilityWeight)*reliability)
  // provenance
  supplyKind: string;
  wouldBeMissedByOrdinary: boolean; // true if ordinary routing's information model can't see this
  reasonOrdinaryWouldMiss?: string;
}

// --- TransportationOpportunity (first-class discovered object) --------------
// An opportunity is a feasible (demand, supply) evaluation that ordinary
// routing structurally cannot construct — because ordinary routing treats
// each demand independently and has no notion of latent supply, transit
// transfer, or truck backhaul.
export interface TransportationOpportunity {
  id: string;
  demandId: string;
  supplyId: string;
  origin: Loc;
  destination: Loc;
  departureWindow: { start: number; end: number };
  arrivalWindow: { start: number; end: number };
  availableCapacity: number;
  detourKm: number;
  detourMinutes: number;
  probabilityOfExecution: number;
  reliability: number;
  supplierCost: number;
  reservationPrice: number;
  userMaxPrice: number;
  negotiatedPrice: number;
  userSurplus: number;
  supplierSurplus: number;
  socialWelfare: number;
  riskAdjustedWelfare: number;
  reasonWhyOrdinaryRoutingWouldMissIt: string;
  supplyKind: string;
}

// --- Strategy identifiers ---------------------------------------------------
export type StrategyId =
  | "ordinary"
  | "multimodal"
  | "pooling-fixed"
  | "centralized"
  | "oryxx"
  | "clairvoyant";

export interface StrategySpec {
  id: StrategyId;
  name: string;
  shortName: string;
  description: string;
  kind: "BASELINE" | "HEURISTIC" | "EXACT";
  seesLatentSupply: boolean;
  seesAllDemand: boolean;
  usesMarketPricing: boolean;
  allowsCrossDemandSharing: boolean;
  color: string;
  // decomposition ladder position (A=0, B=1, ...). Lower = fewer capabilities.
  ladder: number;
}

export const STRATEGIES: StrategySpec[] = [
  {
    id: "ordinary",
    name: "A — Ordinary routing",
    shortName: "Ordinary (A)",
    description:
      "Each demand independently calls a direct on-demand rideshare at market rate. No cross-demand coordination, no latent-supply discovery, no multimodal awareness. Competent but structurally blind to opportunities.",
    kind: "BASELINE",
    seesLatentSupply: false,
    seesAllDemand: false,
    usesMarketPricing: true,
    allowsCrossDemandSharing: false,
    color: "#f59e0b",
    ladder: 0,
  },
  {
    id: "multimodal",
    name: "B — Multimodal planner",
    shortName: "Multimodal (B)",
    description:
      "Each demand independently picks the best feasible supply from ALL modes (rideshare, transit, carpool, truck). NO cross-demand sharing — each non-transit supply serves at most one demand. Isolates the value of multimodal routing.",
    kind: "HEURISTIC",
    seesLatentSupply: true,
    seesAllDemand: false,
    usesMarketPricing: true,
    allowsCrossDemandSharing: false,
    color: "#06b6d4",
    ladder: 1,
  },
  {
    id: "pooling-fixed",
    name: "C — Pooling (fixed price)",
    shortName: "Pooling (C)",
    description:
      "Cross-demand capacity sharing IS allowed, but at fixed market prices (no negotiation). Isolates the value of physical coordination without economic optimization.",
    kind: "HEURISTIC",
    seesLatentSupply: true,
    seesAllDemand: true,
    usesMarketPricing: true,
    allowsCrossDemandSharing: true,
    color: "#8b5cf6",
    ladder: 2,
  },
  {
    id: "centralized",
    name: "D — Centralized coordination",
    shortName: "Centralized (D)",
    description:
      "All demand and supply visible. Welfare-maximizing assignment with negotiated pricing (deterministic 50/50 split). Isolates the value of economic optimization on top of physical coordination.",
    kind: "HEURISTIC",
    seesLatentSupply: true,
    seesAllDemand: true,
    usesMarketPricing: false,
    allowsCrossDemandSharing: true,
    color: "#0ea5e9",
    ladder: 3,
  },
  {
    id: "oryxx",
    name: "E — ORYXX market",
    shortName: "ORYXX (E)",
    description:
      "Cross-demand matching + latent supply + capacity + time + ORYXX market pricing (user-biased split). Isolates the value of the market mechanism specifically.",
    kind: "HEURISTIC",
    seesLatentSupply: true,
    seesAllDemand: true,
    usesMarketPricing: false,
    allowsCrossDemandSharing: true,
    color: "#10b981",
    ladder: 4,
  },
  {
    id: "clairvoyant",
    name: "F — Clairvoyant optimum",
    shortName: "Clairvoyant (F)",
    description:
      "Exact branch-and-bound with perfect knowledge. Upper-bound reference — measures the optimization gap of all heuristics.",
    kind: "EXACT",
    seesLatentSupply: true,
    seesAllDemand: true,
    usesMarketPricing: false,
    allowsCrossDemandSharing: true,
    color: "#ec4899",
    ladder: 5,
  },
];

// --- Price mechanisms -------------------------------------------------------
export type PriceMechanism = "market" | "negotiated" | "oryxx";

// --- Canonical metrics (computed identically for every strategy) -----------
export interface CanonicalMetrics {
  strategyId: StrategyId;
  matchedDemands: number;
  unmatchedDemands: number;
  totalDemands: number;
  matchingRate: number;
  totalUserCost: number; // sum of prices paid
  totalSupplierEarnings: number; // sum of prices received (= totalUserCost)
  totalSupplierCost: number; // real cost incurred
  totalUserSurplus: number; // sum(value - price)
  totalSupplierSurplus: number; // sum(price - supplierCost)
  totalSocialSurplus: number; // userSurplus + supplierSurplus
  totalRiskAdjustedWelfare: number; // sum(riskAdjustedWelfare)
  seatUtilization: number; // matched seat-demand / offered seat-capacity
  emptyVehicleKm: number;
  deadheadKm: number;
  avgTravelTimeMin: number;
  avgDetourKm: number;
  unservedDemandValue: number; // sum of value of unmatched demands
  // solver performance
  solverRuntimeMs: number;
  pairCount: number; // feasible pairs enumerated
  feasiblePairCount: number;
  isExact: boolean;
  // ORYXX moments: matches using supply that ordinary routing cannot see
  // (non-rideshare-market supply). This is the clean thesis metric:
  // "how many valuable opportunities are invisible to ordinary routing?"
  oryxxMomentsCount: number;
  // provenance
  evaluations: TransportationEvaluation[];
}

// --- Experiment results -----------------------------------------------------
export interface SingleRunResult {
  seed: number;
  world: WorldConfig;
  demands: number;
  supplies: number;
  metrics: Record<StrategyId, CanonicalMetrics>;
  opportunities: TransportationOpportunity[];
  invariantsPassed: boolean;
  invariantFailures: string[];
}

export interface ExperimentConfig {
  seed: number;
  numSeeds: number;
  numDemands: number;
  numDrivers: number;
  numNPDs: number;
  numTrucks: number;
  numTransitLines: number;
  regionKm: number;
  world: WorldConfig;
  strategies: StrategyId[];
  // exact solver only runs if demands <= this
  exactMaxDemands: number;
}

export interface SweepPoint {
  label: string;
  value: number;
  results: SingleRunResult[];
}

export interface SweepResult {
  experiment: "planning-horizon" | "npd-density" | "demand-density" | "supply-ratio";
  points: SweepPoint[];
  statistics: SweepStatistics[];
}

export interface SweepStatistics {
  experiment: string;
  pointLabel: string;
  pointValue: number;
  strategyId: StrategyId;
  metric: string;
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  std: number;
  ci95Low: number;
  ci95High: number;
  n: number;
}

// --- Regimes ----------------------------------------------------------------
export interface Regime {
  id: string;
  name: string;
  description: string;
  config: Partial<ExperimentConfig>;
  world: Partial<WorldConfig>;
}

// --- Advantage decomposition ------------------------------------------------
// The ladder A→B→C→D→E→F isolates each mechanism's marginal contribution.
// Each delta = (higher strategy welfare) − (lower strategy welfare), per seed.
export interface DecompositionDelta {
  comparison: string; // "B - A" etc.
  label: string; // "Value of multimodal routing"
  metric: string;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  winRate: number; // fraction of seeds where the delta is positive
  n: number;
}

export interface SuperlinearityPoint {
  dimension: string; // "future-visibility" | "supply-density" | "demand-density" | "npd-density"
  value: number;
  oryxxWelfare: number; // mean ORYXX welfare at this point
  ordinaryWelfare: number; // mean ordinary welfare
  oryxxAdvantage: number; // oryxxWelfare - ordinaryWelfare
  oryxxMoments: number; // mean ORYXX moments count
  n: number;
}

export interface SuperlinearityResult {
  dimension: string;
  points: SuperlinearityPoint[];
  // if the advantage curve is superlinear, isSuperlinear = true
  isSuperlinear: boolean;
  // R² of a quadratic fit to the advantage curve (R² > 0.9 with positive quadratic coefficient = superlinear)
  quadraticR2: number;
  quadraticCoef: number; // sign of the quadratic term
  note: string;
}

// --- Paired comparison ------------------------------------------------------
export interface PairedDiff {
  metric: string;
  // e.g. "oryxx - ordinary"
  comparison: string;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  std: number;
  // fraction of seeds where the left strategy beats the right
  winRate: number;
  n: number;
}
