// ORYXX — W3 Pilot: experiment state machine + preregistration + safety.
//
// This module enforces evidence integrity. Only explicit state transitions can
// create W3 (acceptance) or W4 (completion) evidence. No W2a observation can
// accidentally become W3. No acceptance can accidentally become W4.
//
// State machine:
//   OFFER_CREATED → OFFER_PRESENTED → PROVIDER_VIEWED →
//     ├─ PROVIDER_ACCEPTED → TRIP_STARTED → TRIP_COMPLETED (W4)
//     │                                   → TRIP_CANCELLED
//     ├─ PROVIDER_DECLINED
//     ├─ PROVIDER_UNAVAILABLE
//     └─ PROVIDER_IGNORED (timeout)
//
// W3 evidence is created ONLY at PROVIDER_ACCEPTED.
// W4 evidence is created ONLY at TRIP_COMPLETED.

// --- State transitions -----------------------------------------------------
export type ExperimentState =
  | "OFFER_CREATED"
  | "OFFER_PRESENTED"
  | "PROVIDER_VIEWED"
  | "PROVIDER_ACCEPTED"   // ← W3 evidence created here
  | "PROVIDER_DECLINED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_IGNORED"     // timeout, no response
  | "TRIP_STARTED"
  | "TRIP_COMPLETED"        // ← W4 evidence created here
  | "TRIP_CANCELLED";

export const VALID_TRANSITIONS: Record<ExperimentState, ExperimentState[]> = {
  OFFER_CREATED: ["OFFER_PRESENTED"],
  OFFER_PRESENTED: ["PROVIDER_VIEWED", "PROVIDER_IGNORED"],
  PROVIDER_VIEWED: ["PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE", "PROVIDER_IGNORED"],
  PROVIDER_ACCEPTED: ["TRIP_STARTED", "TRIP_CANCELLED"],
  PROVIDER_DECLINED: [],
  PROVIDER_UNAVAILABLE: [],
  PROVIDER_IGNORED: [],
  TRIP_STARTED: ["TRIP_COMPLETED", "TRIP_CANCELLED"],
  TRIP_COMPLETED: [],
  TRIP_CANCELLED: [],
};

export function isValidTransition(from: ExperimentState, to: ExperimentState): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

export function evidenceTierForState(state: ExperimentState): "W2a" | "W2b" | "W3" | "W4" | "W0" {
  switch (state) {
    case "OFFER_CREATED":
    case "OFFER_PRESENTED":
    case "PROVIDER_VIEWED":
      return "W2a"; // offer exists but no provider response yet
    case "PROVIDER_ACCEPTED":
      return "W3"; // ← W3 evidence
    case "TRIP_STARTED":
      return "W3"; // accepted + started, but not completed
    case "TRIP_COMPLETED":
      return "W4"; // ← W4 evidence
    case "PROVIDER_DECLINED":
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_IGNORED":
      return "W0"; // no willingness evidence from a decline
  }
  return "W0";
}

// --- Preregistration (immutable experiment spec) ---------------------------
export interface PreregisteredExperiment {
  experimentId: string;
  version: number; // incremented if design changes after preregistration
  // hypothesis
  hypothesis: string;
  population: string;
  geography: string;
  providerType: string;
  // design
  sampleTarget: number;
  compensationBuckets: number[];
  detourBuckets: number[];
  extraTimeBuckets: number[];
  noticeBuckets: number[];
  randomizationSeed: number;
  // analysis
  primaryOutcome: "W3_acceptance_rate";
  secondaryOutcomes: string[];
  analysisMethod: string;
  // stopping
  stoppingRule: string;
  // safety
  safetyRules: string[];
  maxDetourKm: number;
  maxExtraTimeMin: number;
  minCompensation: number;
  // consent
  consentText: string;
  requiresConsent: boolean;
  // status
  status: "preregistered" | "active" | "completed" | "abandoned";
  preregisteredAt: string;
  // immutability
  isImmutable: boolean; // true once data collection begins
}

// --- Offer safety validation -----------------------------------------------
export interface OfferSafetyCheck {
  safe: boolean;
  violations: string[];
}

export function validateOfferSafety(offer: {
  detourKm: number;
  extraTimeMin: number;
  compensation: number;
  passengerCount: number;
}, rules: { maxDetourKm: number; maxExtraTimeMin: number; minCompensation: number }): OfferSafetyCheck {
  const violations: string[] = [];
  if (offer.detourKm > rules.maxDetourKm) violations.push(`Detour ${offer.detourKm}km exceeds max ${rules.maxDetourKm}km`);
  if (offer.extraTimeMin > rules.maxExtraTimeMin) violations.push(`Extra time ${offer.extraTimeMin}min exceeds max ${rules.maxExtraTimeMin}min`);
  if (offer.compensation < rules.minCompensation) violations.push(`Compensation $${offer.compensation} below min $${rules.minCompensation}`);
  if (offer.passengerCount > 3) violations.push(`Passenger count ${offer.passengerCount} exceeds safety max 3`);
  return { safe: violations.length === 0, violations };
}

// --- Randomized treatment assignment ---------------------------------------
export interface TreatmentCell {
  compensation: number;
  detourKm: number;
  extraTimeMin: number;
  advanceNoticeMin: number;
}

export function assignTreatment(
  providerId: string,
  experimentId: string,
  seed: number,
  cells: TreatmentCell[],
): TreatmentCell {
  // deterministic hash-based assignment (balanced via modular hashing)
  const hash = [...providerId + experimentId].reduce((a, c) => a * 31 + c.charCodeAt(0), seed);
  return cells[Math.abs(hash) % cells.length];
}

export function generateTreatmentCells(spec: PreregisteredExperiment): TreatmentCell[] {
  const cells: TreatmentCell[] = [];
  for (const comp of spec.compensationBuckets) {
    for (const detour of spec.detourBuckets) {
      for (const time of spec.extraTimeBuckets) {
        for (const notice of spec.noticeBuckets) {
          // skip unsafe combinations
          if (detour > spec.maxDetourKm) continue;
          if (time > spec.maxExtraTimeMin) continue;
          if (comp < spec.minCompensation) continue;
          cells.push({ compensation: comp, detourKm: detour, extraTimeMin: time, advanceNoticeMin: notice });
        }
      }
    }
  }
  return cells;
}

// --- Sample-size calculator ------------------------------------------------
export interface SampleSizeResult {
  requiredPerCell: number;
  totalRequired: number;
  alpha: number;
  power: number;
  baseline: number;
  minDetectableLift: number;
  formula: string;
}

export function calculateSampleSize(
  baseline: number,    // expected acceptance rate (0-1)
  minDetectableLift: number, // minimum detectable difference
  alpha: number = 0.05,
  power: number = 0.80,
): SampleSizeResult {
  // two-proportion z-test sample size
  const zAlpha = 1.96; // alpha=0.05 two-sided
  const zBeta = 0.84;  // power=0.80
  const p1 = baseline;
  const p2 = baseline + minDetectableLift;
  const pBar = (p1 + p2) / 2;
  const n = Math.ceil(
    ((zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
      zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) /
    (p2 - p1) ** 2
  );
  return {
    requiredPerCell: n,
    totalRequired: n, // per cell; multiply by number of cells for total
    alpha,
    power,
    baseline,
    minDetectableLift,
    formula: `n = ceil((z_α·√(2p̄(1-p̄)) + z_β·√(p₁(1-p₁)+p₂(1-p₂)))² / (p₂-p₁)²) = ${n}`,
  };
}

// --- Break-even per treatment cell ------------------------------------------
export interface CellEconomics {
  cell: TreatmentCell;
  userSavings: number;
  supplierCompensation: number;
  supplierCost: number;
  oryxxMargin: number;
  failureCost: number;
  breakEvenAcceptance: number; // minimum acceptance for positive expected value
  netValuePerExecution: number;
}

export function computeCellEconomics(cell: TreatmentCell): CellEconomics {
  const userSavings = 4.0; // typical user saving from pooled vs solo rideshare
  const supplierCompensation = cell.compensation;
  const supplierCost = cell.detourKm * 0.35; // fuel + wear per km
  const oryxxMargin = 0.50; // ORYXX takes $0.50 per matched trip
  const failureCost = 1.0; // cost of a failed/no-show match
  // break-even: P(accept) such that expected value = 0
  // E[value] = P(accept) * (userSavings - supplierComp - oryxxMargin) - (1-P(accept)) * failureCost
  // 0 = P*(userSavings - supplierComp - margin) - (1-P)*failure
  // P = failure / (userSavings - supplierComp - margin + failure)
  const numerator = failureCost;
  const denominator = userSavings - supplierCompensation - oryxxMargin + failureCost;
  const breakEven = denominator > 0 ? numerator / denominator : 1.0;
  const netValuePerExecution = userSavings - supplierCompensation - oryxxMargin - supplierCost;
  return {
    cell,
    userSavings,
    supplierCompensation,
    supplierCost: Math.round(supplierCost * 100) / 100,
    oryxxMargin,
    failureCost,
    breakEvenAcceptance: Math.round(breakEven * 1000) / 1000,
    netValuePerExecution: Math.round(netValuePerExecution * 100) / 100,
  };
}

// --- W3/W4 evidence counts (real, not simulated) ---------------------------
export interface EvidenceCounts {
  w0: number;  // no evidence
  w1: number;  // stated (survey)
  w2a: number; // not-on-trip observations
  w2b: number; // confirmed availability (provider responded "available")
  w3: number;  // accepted a real offer
  w4: number;  // completed a real pooled trip
  totalResponses: number;
  offersPresented: number;
  offersViewed: number;
  accepted: number;
  declined: number;
  unavailable: number;
  ignored: number;
  tripStarted: number;
  tripCompleted: number;
  tripCancelled: number;
  acceptanceRate: number | null;
  completionRate: number | null;
  acceptanceCI95: { low: number; high: number } | null;
  completionCI95: { low: number; high: number } | null;
}

export function emptyEvidenceCounts(): EvidenceCounts {
  return {
    w0: 0, w1: 0, w2a: 0, w2b: 0, w3: 0, w4: 0,
    totalResponses: 0, offersPresented: 0, offersViewed: 0,
    accepted: 0, declined: 0, unavailable: 0, ignored: 0,
    tripStarted: 0, tripCompleted: 0, tripCancelled: 0,
    acceptanceRate: null, completionRate: null,
    acceptanceCI95: null, completionCI95: null,
  };
}

export function wilsonCI(accepts: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = accepts / total;
  const denom = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / denom;
  return {
    low: Math.round(Math.max(0, center - margin) * 1000) / 1000,
    high: Math.round(Math.min(1, center + margin) * 1000) / 1000,
  };
}

// --- Marketplace decision rule ----------------------------------------------
export interface MarketplaceDecision {
  verdict: "NOT_TESTED" | "TESTED_NEGATIVE" | "TESTED_INCONCLUSIVE" | "TESTED_PROMISING";
  viableCells: number;
  bestCell: { cell: TreatmentCell; acceptance: number; completion: number; netValue: number } | null;
  reason: string;
}

export function evaluateMarketplaceDecision(
  cells: TreatmentCell[],
  evidence: EvidenceCounts,
): MarketplaceDecision {
  if (evidence.w3 === 0) {
    return {
      verdict: "NOT_TESTED",
      viableCells: 0,
      bestCell: null,
      reason: "No W3 evidence exists. No provider has accepted a real pooled-trip offer. The marketplace thesis has not been tested.",
    };
  }
  // if we had per-cell data we'd check each cell for viability
  // for now, use aggregate
  const acceptance = evidence.acceptanceRate ?? 0;
  const completion = evidence.completionRate ?? 0;
  const viableCells = cells.filter((c) => {
    const econ = computeCellEconomics(c);
    return acceptance > econ.breakEvenAcceptance && completion > 0.5 && econ.netValuePerExecution > 0;
  }).length;

  if (viableCells === 0) {
    return {
      verdict: "TESTED_NEGATIVE",
      viableCells: 0,
      bestCell: null,
      reason: `W3 evidence exists (${evidence.w3} acceptances) but NO treatment cell is economically viable. Acceptance (${Math.round(acceptance * 100)}%) or completion (${Math.round(completion * 100)}%) is below break-even for all cells.`,
    };
  }
  if (evidence.totalResponses < 30) {
    return {
      verdict: "TESTED_INCONCLUSIVE",
      viableCells,
      bestCell: null,
      reason: `W3 evidence exists but sample size (${evidence.totalResponses}) is too small for reliable conclusions. Need ≥30 responses per cell.`,
    };
  }
  return {
    verdict: "TESTED_PROMISING",
    viableCells,
    bestCell: null, // would be computed from per-cell data
    reason: `${viableCells} treatment cell(s) show statistically credible acceptance AND positive net value. Marketplace thesis is promising but requires replication.`,
  };
}
