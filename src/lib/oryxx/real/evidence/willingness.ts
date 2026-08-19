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
// W0 — no evidence
// W1 — stated willingness (survey, hypothetical)
// W2a — not-on-trip observation (vehicle was not recorded on a trip; does NOT
//        prove the driver was available to ORYXX — they may have been on break,
//        refusing rides, or unavailable for other reasons)
// W2b — confirmed provider availability / searching state (driver actively
//        searching for a ride on a platform — still NOT acceptance of a specific
//        pooled request)
// W3 — revealed acceptance (provider accepted a SPECIFIC real offer)
// W4 — completed execution (provider accepted AND completed the pooled trip)
//
// CRITICAL: W2a is NOT "revealed willingness." An inter-trip gap only means
// the vehicle was not on a recorded trip. It does NOT mean the driver was
// available, willing, or able to accept an additional passenger.
export type WillingnessTier = "W0" | "W1" | "W2a" | "W2b" | "W3" | "W4";

export interface WillingnessTierMeta {
  tier: WillingnessTier;
  name: string;
  description: string;
  strength: number; // 0-4
  isEmpirical: boolean;
  marketplaceSufficient: boolean;
  label: "EMPIRICAL" | "INFERRED" | "ASSUMED" | "NONE";
}

export const WILLINGNESS_TIERS: WillingnessTierMeta[] = [
  { tier: "W0", name: "No evidence", description: "No provider response data at all.", strength: 0, isEmpirical: false, marketplaceSufficient: false, label: "NONE" },
  { tier: "W1", name: "Stated willingness", description: "Provider says they would accept under a hypothetical scenario. Survey/conjoint. Stated ≠ revealed.", strength: 1, isEmpirical: true, marketplaceSufficient: false, label: "EMPIRICAL" },
  { tier: "W2a", name: "Not-on-trip observation", description: "Vehicle was not recorded on a trip (inter-trip gap). Does NOT prove availability — driver may have been on break, refusing rides, or unavailable. NOT 'revealed willingness.'", strength: 2, isEmpirical: true, marketplaceSufficient: false, label: "EMPIRICAL" },
  { tier: "W2b", name: "Confirmed availability", description: "Provider was confirmed available/searching on a platform. Still NOT acceptance of a specific request.", strength: 2.5, isEmpirical: true, marketplaceSufficient: false, label: "EMPIRICAL" },
  { tier: "W3", name: "Revealed acceptance", description: "Provider accepted a SPECIFIC real offer. The minimum for marketplace justification.", strength: 3, isEmpirical: true, marketplaceSufficient: true, label: "EMPIRICAL" },
  { tier: "W4", name: "Completed execution", description: "Provider accepted AND completed the pooled trip. Strongest evidence.", strength: 4, isEmpirical: true, marketplaceSufficient: true, label: "EMPIRICAL" },
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
  evidenceSource: "nyc-fhv-gaps" | "simulated-w1" | "simulated-w2" | "field-experiment";
  // model parameters (for the acceptance model fit)
  compensationLevels: number[];
  detourLevels: number[];
  noticeLevels: number[];
}

// --- Provider response (W3/W4 field-experiment data) -----------------------
// A REAL provider response to a REAL offer. This is the W3 evidence the
// marketplace thesis requires. Until real responses exist, W3 = 0.
export interface ProviderResponse {
  id: string;
  experimentId: string;
  providerId: string; // pseudonymous
  // the offer presented to the provider
  offer: {
    compensation: number;
    detourKm: number;
    extraTimeMin: number;
    advanceNoticeMin: number;
    passengerCount: number;
    tripDistanceKm: number;
    originName: string;
    destName: string;
    hourOfDay: number;
  };
  // the provider's decision
  decision: "accept" | "decline" | "not_available" | "not_eligible" | "ignore";
  // execution outcome (if accepted)
  executed: boolean | null; // did the trip actually happen?
  completed: boolean | null; // was it completed successfully?
  executionFailureReason: string | null;
  // evidence tier
  evidenceTier: WillingnessTier; // W3 if accepted, W4 if completed
  // consent + provenance
  consentObtained: boolean;
  source: DataSource;
  timestamp: string;
}

// --- Field experiment design ------------------------------------------------
export interface FieldExperimentDesign {
  id: string;
  name: string;
  description: string;
  // randomized factors
  compensationLevels: number[];
  detourLevels: number[];
  extraTimeLevels: number[];
  noticeLevels: number[];
  // safety constraints
  maxDetourKm: number; // unsafe above this
  minCompensation: number; // ethically unfair below this
  // consent requirements
  requiresConsent: boolean;
  consentText: string;
  // status
  status: "designed" | "recruiting" | "active" | "completed" | "not_deployable";
  // results (populated when W3 data exists)
  responses: ProviderResponse[];
  totalOffered: number;
  totalAccepted: number;
  totalCompleted: number;
  acceptanceRate: number | null; // null until data exists
  completionRate: number | null;
  acceptanceCI95: { low: number; high: number } | null;
  completionCI95: { low: number; high: number } | null;
}

// --- Funnel with evidence levels -------------------------------------------
export interface FunnelStepWithEvidence {
  step: string;
  count: number;
  pctOfTotal: number;
  pctOfPrevious: number;
  evidenceLevel: "EMPIRICAL" | "INFERRED" | "ASSUMED" | "NONE";
  evidenceNote: string;
}
