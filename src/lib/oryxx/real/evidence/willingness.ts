// ORYXX — Willingness evidence tiers (W0-W4) + acceptance model types.
//
// This extends the evidence ladder to attack Tier D (observed willingness).
// The previous model had only "D-observed | E-assumed" — this adds the
// W0-W4 granularity that distinguishes stated preference from revealed
// acceptance from completed execution.
//
// W0 — NO WILLINGNESS EVIDENCE
// W1 — STATED WILLINGNESS (survey / hypothetical)
// W2 — REVEALED AVAILABILITY (driver was observed available/searching)
// W3 — REVEALED ACCEPTANCE (driver accepted a specific opportunity)
// W4 — COMPLETED EXECUTION (driver accepted + completed the pooled trip)
//
// The marketplace thesis requires W3+. We currently have W2 (from NYC FHV
// inter-trip gap analysis: drivers were observed available for median 8.6 min).
// We do NOT have W3 or W4.

import type { Loc, DataSource } from "../types";
import type { EvidenceLevel } from "./types";

// --- Willingness evidence tier ------------------------------------------------
export type WillingnessTier = "W0" | "W1" | "W2" | "W3" | "W4";

export interface WillingnessTierMeta {
  tier: WillingnessTier;
  name: string;
  description: string;
  strength: number; // 0-4
  isEmpirical: boolean;
  marketplaceSufficient: boolean; // true if this tier can justify marketplace
}

export const WILLINGNESS_TIERS: WillingnessTierMeta[] = [
  { tier: "W0", name: "No evidence", description: "No provider response data at all.", strength: 0, isEmpirical: false, marketplaceSufficient: false },
  { tier: "W1", name: "Stated willingness", description: "Provider says they would accept under a hypothetical scenario. Survey/conjoint. Weak — stated ≠ revealed.", strength: 1, isEmpirical: true, marketplaceSufficient: false },
  { tier: "W2", name: "Revealed availability", description: "Driver was observed available and searching (inter-trip gaps). Proves availability, NOT acceptance of a specific request.", strength: 2, isEmpirical: true, marketplaceSufficient: false },
  { tier: "W3", name: "Revealed acceptance", description: "Provider accepted a specific real opportunity. The minimum for marketplace justification.", strength: 3, isEmpirical: true, marketplaceSufficient: true },
  { tier: "W4", name: "Completed execution", description: "Provider accepted AND completed the pooled trip. Strongest evidence.", strength: 4, isEmpirical: true, marketplaceSufficient: true },
];

// --- Acceptance observation (one data point) --------------------------------
export interface AcceptanceObservation {
  id: string;
  providerId: string; // pseudonymous
  // opportunity parameters offered
  compensation: number; // $ offered
  detourKm: number;
  extraTimeMin: number;
  advanceNoticeMin: number; // 0 = immediate
  passengerCount: number;
  tripDistanceKm: number;
  hourOfDay: number;
  // response
  decision: "accept" | "decline" | "later" | "not_eligible" | "not_interested";
  // execution (if accepted)
  executed: boolean | null; // did the trip actually happen?
  completed: boolean | null; // was it completed successfully?
  // evidence tier of THIS observation
  tier: WillingnessTier;
  // provenance
  source: DataSource;
  timestamp: string;
}

// --- Acceptance model: P(accept | params) ----------------------------------
export interface AcceptanceModelInput {
  compensation: number;
  detourKm: number;
  extraTimeMin: number;
  advanceNoticeMin: number;
  passengerCount: number;
  tripDistanceKm: number;
  hourOfDay: number;
}

export interface AcceptanceModelResult {
  pAccept: number; // 0-1
  uncertainty: number; // 0-1 (higher = less certain)
  tier: WillingnessTier;
  evidenceCount: number; // how many observations informed this estimate
  basis: string; // human-readable explanation
}

// --- Opportunity funnel -----------------------------------------------------
export interface OpportunityFunnelStep {
  step: string;
  count: number;
  pctOfTotal: number;
  pctOfPrevious: number;
}

export interface OpportunityFunnel {
  steps: OpportunityFunnelStep[];
  totalMovements: number;
  finalExecutedOpportunities: number;
  finalExecutedPer1000: number;
}

// --- Break-even analysis ----------------------------------------------------
export interface BreakEvenAnalysis {
  detourKm: number;
  minAcceptanceForBreakEven: number; // fraction
  currentEstimatedAcceptance: number;
  isViable: boolean; // current > break-even
  gap: number; // current - break-even (positive = viable)
}

// --- Willingness experiment result ------------------------------------------
export interface WillingnessExperimentResult {
  config: WillingnessExperimentConfig;
  pilot: {
    name: string;
    description: string;
    datasets: DataSource[];
  };
  // evidence tier achieved
  evidenceTier: WillingnessTier;
  evidenceTierName: string;
  evidenceTierDescription: string;
  marketplaceSufficient: boolean;
  // observations
  observations: AcceptanceObservation[];
  totalObservations: number;
  // acceptance model
  acceptanceModel: {
    intercept: number;
    compensationCoef: number;
    detourCoef: number;
    extraTimeCoef: number;
    noticeCoef: number;
    modelR2: number;
    basis: string;
  };
  // acceptance curves
  acceptanceVsCompensation: { compensation: number; pAccept: number; ciLow: number; ciHigh: number }[];
  acceptanceVsDetour: { detourKm: number; pAccept: number; ciLow: number; ciHigh: number }[];
  acceptanceVsTime: { extraTimeMin: number; pAccept: number; ciLow: number; ciHigh: number }[];
  acceptanceVsNotice: { noticeMin: number; pAccept: number; ciLow: number; ciHigh: number }[];
  // opportunity funnel (integrating capacity + willingness)
  funnel: OpportunityFunnel;
  // break-even analysis
  breakEven: BreakEvenAnalysis[];
  // economic metrics
  expectedExecutedPer1000: number;
  expectedUserSavingsPer1000: number;
  expectedSupplierEarningsPer1000: number;
  netEconomicValuePer1000: number;
  // caveats
  caveats: string[];
  biases: string[];
  whatIsAssumed: string[];
  whatIsObserved: string[];
  generatedAt: string;
}

export interface WillingnessExperimentConfig {
  seed: number;
  numDemands: number;
  // which evidence source to use
  evidenceSource: "nyc-fhv-gaps" | "simulated-w1" | "simulated-w2";
  // model parameters (for the acceptance model fit)
  compensationLevels: number[];
  detourLevels: number[];
  noticeLevels: number[];
}
