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
export type StrategyId = "ordinary" | "centralized" | "oryxx" | "clairvoyant";

export interface StrategySpec {
  id: StrategyId;
  name: string;
  shortName: string;
  description: string;
  kind: "BASELINE" | "HEURISTIC" | "EXACT";
  seesLatentSupply: boolean;
  seesAllDemand: boolean;
  usesMarketPricing: boolean;
  color: string;
}

export const STRATEGIES: StrategySpec[] = [
  {
    id: "ordinary",
    name: "Ordinary routing",
    shortName: "Ordinary",
    description:
      "Each demand independently calls a direct on-demand rideshare at market rate. No cross-demand coordination, no latent-supply discovery, no market clearing. Competent at its own task but structurally blind to opportunities.",
    kind: "BASELINE",
    seesLatentSupply: false,
    seesAllDemand: false,
    usesMarketPricing: false,
    color: "#f59e0b",
  },
  {
    id: "centralized",
    name: "Centralized coordination",
    shortName: "Centralized",
    description:
      "All demand and supply are visible to a central optimizer that matches trips and capacity to maximize welfare. No autonomous negotiation or market mechanism — just a benevolent dispatcher. Measures the value of coordination itself.",
    kind: "HEURISTIC",
    seesLatentSupply: true,
    seesAllDemand: true,
    usesMarketPricing: false,
    color: "#0ea5e9",
  },
  {
    id: "oryxx",
    name: "ORYXX market",
    shortName: "ORYXX",
    description:
      "Cross-demand matching + latent supply + capacity + time + risk-adjusted pricing + execution probability. Welfare-greedy construction with bounded 2-opt local improvement. Subsumes ordinary routing (rideshare fallback) but discovers latent-supply opportunities.",
    kind: "HEURISTIC",
    seesLatentSupply: true,
    seesAllDemand: true,
    usesMarketPricing: true,
    color: "#10b981",
  },
  {
    id: "clairvoyant",
    name: "Clairvoyant optimum",
    shortName: "Clairvoyant",
    description:
      "Exact branch-and-bound solver with perfect knowledge of the simulated world. Maximizes total risk-adjusted social welfare subject to identical constraints. An upper-bound reference — measures the heuristic gap of ORYXX and centralized.",
    kind: "EXACT",
    seesLatentSupply: true,
    seesAllDemand: true,
    usesMarketPricing: false,
    color: "#8b5cf6",
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
