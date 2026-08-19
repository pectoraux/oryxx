// ORYXX — Research-integrity-safe pilot infrastructure.
//
// This module replaces the previous pilot.ts with a version that enforces:
// 1. Application states ≠ evidence tiers (OFFER_CREATED is NOT W2a)
// 2. Only real provider decisions create W3; only real completions create W4
// 3. Preregistration is immutable after activation (with hash)
// 4. Balanced randomization (seeded, reproducible, stratified)
// 5. Per-cell treatment matrix
// 6. Sample-size calculator using actual alpha/power
// 7. Event log (append-only audit trail)
// 8. Offer expiration
//
// SYNTHETIC DATA IS NEVER ALLOWED IN THE EMPIRICAL PIPELINE.

import { createHash } from "crypto";

// =====================================================================
// 1. APPLICATION STATE MACHINE (separate from evidence tiers)
// =====================================================================

export type ExperimentState =
  | "OFFER_CREATED"
  | "OFFER_PRESENTED"
  | "PROVIDER_VIEWED"
  | "PROVIDER_ACCEPTED"
  | "PROVIDER_DECLINED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_IGNORED"
  | "TRIP_STARTED"
  | "TRIP_COMPLETED"
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

// =====================================================================
// 2. EVIDENCE TIERS (what is known about THE WORLD, not the app)
// =====================================================================
// Evidence tiers describe real-world observations, NOT application states.
// An offer existing in the database does NOT mean W2a was observed.
// W2a = "a vehicle was observed not-on-trip in real movement data."
// W3 = "a real provider accepted a real offer" (requires PROVIDER_ACCEPTED state).
// W4 = "a real provider completed the accepted trip" (requires TRIP_COMPLETED state).

export type EvidenceTier = "NONE" | "A" | "B" | "C" | "W2a" | "W2b" | "W3" | "W4";

export function evidenceTierForState(state: ExperimentState): EvidenceTier {
  // Application states do NOT automatically produce evidence tiers.
  // Only explicit provider decisions and trip outcomes produce evidence.
  switch (state) {
    case "PROVIDER_ACCEPTED":
    case "TRIP_STARTED":
      return "W3"; // provider accepted a REAL offer
    case "TRIP_COMPLETED":
      return "W4"; // trip completed
    // All other application states produce NO evidence tier:
    // OFFER_CREATED, OFFER_PRESENTED, PROVIDER_VIEWED → NONE (not W2a!)
    // PROVIDER_DECLINED, PROVIDER_UNAVAILABLE, PROVIDER_IGNORED → NONE
    // TRIP_CANCELLED → NONE
    default:
      return "NONE";
  }
}

// =====================================================================
// 3. PREREGISTRATION (immutable after activation, with hash)
// =====================================================================

export type ExperimentStatus = "DRAFT" | "PREREGISTERED" | "ACTIVE" | "COMPLETED" | "ABANDONED";

export interface PreregisteredDesign {
  hypothesis: string;
  population: string;
  geography: string;
  providerType: string;
  sampleTarget: number;
  compensationBuckets: number[];
  detourBuckets: number[];
  extraTimeBuckets: number[];
  noticeBuckets: number[];
  randomizationSeed: number;
  primaryOutcome: string;
  secondaryOutcomes: string[];
  analysisMethod: string;
  stoppingRule: string;
  safetyRules: string[];
  maxDetourKm: number;
  maxExtraTimeMin: number;
  minCompensation: number;
  consentText: string;
  // economic assumptions (labelled, not observed)
  assumedUserSavings: number;
  assumedFailureCost: number;
  assumedOryxxMargin: number;
}

export function computePreregistrationHash(design: PreregisteredDesign): string {
  // canonical JSON (sorted keys) → FULL SHA-256 (not truncated)
  const canonical = JSON.stringify(design, Object.keys(design).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export function canMutateDesign(status: ExperimentStatus): boolean {
  // design is mutable only in DRAFT or PREREGISTERED (before activation)
  return status === "DRAFT" || status === "PREREGISTERED";
}

// =====================================================================
// 4. BALANCED RANDOMIZATION (seeded, reproducible, stratified)
// =====================================================================

export interface TreatmentCell {
  id: string;
  compensation: number;
  detourKm: number;
  extraTimeMin: number;
  advanceNoticeMin: number;
}

export function generateTreatmentCells(design: PreregisteredDesign): TreatmentCell[] {
  const cells: TreatmentCell[] = [];
  for (const comp of design.compensationBuckets) {
    for (const detour of design.detourBuckets) {
      for (const time of design.extraTimeBuckets) {
        for (const notice of design.noticeBuckets) {
          if (detour > design.maxDetourKm) continue;
          if (time > design.maxExtraTimeMin) continue;
          if (comp < design.minCompensation) continue;
          cells.push({
            id: `cell-${comp}-${detour}-${time}-${notice}`,
            compensation: comp,
            detourKm: detour,
            extraTimeMin: time,
            advanceNoticeMin: notice,
          });
        }
      }
    }
  }
  return cells;
}

// Balanced randomization: assign the LEAST-FILLED eligible cell, with a
// deterministic randomized tiebreak (seeded). This guarantees balance
// across treatment cells. The assignment is reproducible from
// (participantId, experimentId, seed, cellCounts).
export function assignTreatment(
  participantId: string,
  experimentId: string,
  seed: number,
  cells: TreatmentCell[],
  cellCounts: number[], // current count per cell (same order as cells)
): TreatmentCell {
  if (cells.length === 0) throw new Error("No treatment cells available");
  // find the minimum count
  const minCount = Math.min(...cellCounts);
  // collect all cells at the minimum count (tie candidates)
  const candidates: number[] = [];
  for (let i = 0; i < cellCounts.length; i++) {
    if (cellCounts[i] === minCount) candidates.push(i);
  }
  // deterministic tiebreak: hash participantId+experimentId+seed → pick one
  const hash = [...participantId + experimentId].reduce((a, c) => a * 31 + c.charCodeAt(0), seed);
  const winner = candidates[Math.abs(hash) % candidates.length];
  return cells[winner];
}

// =====================================================================
// 5. OFFER SAFETY VALIDATION (server-side)
// =====================================================================

export interface OfferSafetyCheck {
  safe: boolean;
  violations: string[];
}

export function validateOfferSafety(
  offer: { detourKm: number; extraTimeMin: number; compensation: number; passengerCount: number },
  rules: { maxDetourKm: number; maxExtraTimeMin: number; minCompensation: number },
): OfferSafetyCheck {
  const violations: string[] = [];
  if (offer.detourKm > rules.maxDetourKm) violations.push(`Detour ${offer.detourKm}km exceeds max ${rules.maxDetourKm}km`);
  if (offer.extraTimeMin > rules.maxExtraTimeMin) violations.push(`Extra time ${offer.extraTimeMin}min exceeds max ${rules.maxExtraTimeMin}min`);
  if (offer.compensation < rules.minCompensation) violations.push(`Compensation $${offer.compensation} below min $${rules.minCompensation}`);
  if (offer.passengerCount > 3) violations.push(`Passenger count ${offer.passengerCount} exceeds safety max 3`);
  return { safe: violations.length === 0, violations };
}

// =====================================================================
// 6. OFFER EXPIRATION
// =====================================================================

export function isOfferExpired(offerPresentedAt: string | null, expiresAfterMin: number = 30): boolean {
  if (!offerPresentedAt) return false; // not presented yet
  const presented = new Date(offerPresentedAt).getTime();
  const expiresAt = presented + expiresAfterMin * 60 * 1000;
  return Date.now() > expiresAt;
}

// =====================================================================
// 7. SAMPLE-SIZE CALCULATOR (uses actual alpha/power)
// =====================================================================

export interface SampleSizeResult {
  requiredPerCell: number;
  totalRequired: number;
  numCells: number;
  alpha: number;
  power: number;
  baseline: number;
  minDetectableLift: number;
  formula: string;
}

// Inverse normal CDF (approximation) — computes z from p
// Replace zScore with the hardcoded + Acklam version
function zScore(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (Math.abs(p - 0.975) < 0.001) return 1.96;
  if (Math.abs(p - 0.95) < 0.001) return 1.645;
  if (Math.abs(p - 0.80) < 0.001) return 0.842;
  if (Math.abs(p - 0.90) < 0.001) return 1.282;
  if (Math.abs(p - 0.50) < 0.001) return 0;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, z: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    z = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    const r = q * q;
    z = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+b[5]);
  } else {
    q = Math.sqrt(-2 * Math.log(1-p));
    z = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  return z;
}

export function calculateSampleSize(
  baseline: number,
  minDetectableLift: number,
  alpha: number = 0.05,
  power: number = 0.80,
  numCells: number = 1,
): SampleSizeResult {
  const zAlpha = zScore(1 - alpha / 2); // two-sided
  const zBeta = zScore(power);
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
    totalRequired: n * numCells,
    numCells,
    alpha,
    power,
    baseline,
    minDetectableLift,
    formula: `n_per_cell = ceil((z_α(${zAlpha.toFixed(3)})·√(2p̄(1-p̄)) + z_β(${zBeta.toFixed(3)})·√(p₁(1-p₁)+p₂(1-p₂)))² / (p₂-p₁)²) = ${n}, total = ${n}×${numCells} = ${n * numCells}`,
  };
}

// =====================================================================
// 8. PER-CELL ECONOMICS + BREAK-EVEN
// =====================================================================

export interface CellEconomics {
  cell: TreatmentCell;
  // economic assumptions (labelled, NOT observed)
  assumedUserSavings: number;
  supplierCompensation: number;
  supplierCost: number;
  oryxxMargin: number;
  failureCost: number;
  breakEvenAcceptance: number;
  netValuePerExecution: number;
}

export function computeCellEconomics(cell: TreatmentCell, design: PreregisteredDesign): CellEconomics {
  const userSavings = design.assumedUserSavings;
  const supplierCompensation = cell.compensation;
  const supplierCost = Math.round(cell.detourKm * 0.35 * 100) / 100;
  const oryxxMargin = design.assumedOryxxMargin;
  const failureCost = design.assumedFailureCost;
  const numerator = failureCost;
  const denominator = userSavings - supplierCompensation - oryxxMargin + failureCost;
  const breakEven = denominator > 0 ? numerator / denominator : 1.0;
  const netValue = userSavings - supplierCompensation - oryxxMargin - supplierCost;
  return {
    cell,
    assumedUserSavings: userSavings,
    supplierCompensation,
    supplierCost,
    oryxxMargin,
    failureCost,
    breakEvenAcceptance: Math.round(breakEven * 1000) / 1000,
    netValuePerExecution: Math.round(netValue * 100) / 100,
  };
}

// =====================================================================
// 9. PER-CELL TREATMENT MATRIX
// =====================================================================

export interface CellResult {
  cell: TreatmentCell;
  economics: CellEconomics;
  offers: number;
  viewed: number;
  accepted: number;
  declined: number;
  unavailable: number;
  ignored: number;
  started: number;
  completed: number;
  cancelled: number;
  acceptanceRate: number | null;
  completionRate: number | null;
  acceptanceCI95: { low: number; high: number } | null;
  completionCI95: { low: number; high: number } | null;
}

export function wilsonCI(accepts: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = zScore(0.975);
  const p = accepts / total;
  const denom = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / denom;
  return {
    low: Math.round(Math.max(0, center - margin) * 1000) / 1000,
    high: Math.round(Math.min(1, center + margin) * 1000) / 1000,
  };
}

// =====================================================================
// 10. MARKETPLACE DECISION RULE (per-cell, preregistered criteria)
// =====================================================================

export type MarketplaceVerdict = "NOT_TESTED" | "TESTED_NEGATIVE" | "TESTED_INCONCLUSIVE" | "TESTED_PROMISING";

export interface MarketplaceDecision {
  verdict: MarketplaceVerdict;
  viableCells: number;
  bestCell: { cellId: string; acceptance: number; completion: number; netValue: number } | null;
  cellResults: { cellId: string; verdict: MarketplaceVerdict; reason: string }[];
  reason: string;
}

export function evaluateMarketplaceDecision(
  cellResults: CellResult[],
  minSamplePerCell: number,
): MarketplaceDecision {
  if (cellResults.every((c) => c.offers === 0)) {
    return {
      verdict: "NOT_TESTED",
      viableCells: 0,
      bestCell: null,
      cellResults: [],
      reason: "No W3 evidence exists. No offers have been presented to real providers.",
    };
  }

  const cellVerdicts = cellResults.map((cr) => {
    if (cr.offers < minSamplePerCell) {
      return { cellId: cr.cell.id, verdict: "TESTED_INCONCLUSIVE" as MarketplaceVerdict, reason: `n=${cr.offers} < min=${minSamplePerCell}` };
    }
    const acceptance = cr.acceptanceRate ?? 0;
    const completion = cr.completionRate ?? 0;
    const econ = cr.economics;
    if (acceptance >= econ.breakEvenAcceptance && completion > 0.5 && econ.netValuePerExecution > 0) {
      return { cellId: cr.cell.id, verdict: "TESTED_PROMISING" as MarketplaceVerdict, reason: `acceptance=${Math.round(acceptance*100)}% ≥ break-even=${Math.round(econ.breakEvenAcceptance*100)}%, completion=${Math.round(completion*100)}%, net=$${econ.netValuePerExecution}` };
    }
    return { cellId: cr.cell.id, verdict: "TESTED_NEGATIVE" as MarketplaceVerdict, reason: `acceptance=${Math.round(acceptance*100)}% < break-even=${Math.round(econ.breakEvenAcceptance*100)}% OR completion=${Math.round(completion*100)}% ≤ 50% OR net=$${econ.netValuePerExecution} ≤ 0` };
  });

  const viable = cellVerdicts.filter((v) => v.verdict === "TESTED_PROMISING");
  const best = viable.length > 0
    ? cellResults.find((cr) => cr.cell.id === viable[0].cellId)
    : null;

  return {
    verdict: viable.length > 0 ? "TESTED_PROMISING" : cellVerdicts.every(v => v.verdict === "TESTED_INCONCLUSIVE") ? "TESTED_INCONCLUSIVE" : "TESTED_NEGATIVE",
    viableCells: viable.length,
    bestCell: best ? { cellId: best.cell.id, acceptance: best.acceptanceRate ?? 0, completion: best.completionRate ?? 0, netValue: best.economics.netValuePerExecution } : null,
    cellResults: cellVerdicts,
    reason: viable.length > 0
      ? `${viable.length} treatment cell(s) show acceptance ≥ break-even AND completion > 50% AND positive net value.`
      : "No treatment cell meets all viability criteria.",
  };
}

// =====================================================================
// 11. EVENT LOG (append-only audit trail)
// =====================================================================

export interface ExperimentEvent {
  id: string;
  experimentId: string;
  offerId: string;
  participantId: string;
  fromState: ExperimentState | null;
  toState: ExperimentState;
  timestamp: string;
  actorType: "system" | "participant" | "admin";
  actorId: string;
  metadataHash: string;
}

export function createEvent(
  experimentId: string,
  offerId: string,
  participantId: string,
  fromState: ExperimentState | null,
  toState: ExperimentState,
  actorType: "system" | "participant" | "admin",
  actorId: string,
): ExperimentEvent {
  const timestamp = new Date().toISOString();
  const data = `${experimentId}|${offerId}|${participantId}|${fromState}|${toState}|${timestamp}`;
  const metadataHash = createHash("sha256").update(data).digest("hex").substring(0, 16);
  return {
    id: `EVT-${createHash("sha256").update(data + Math.random()).digest("hex").substring(0, 12)}`,
    experimentId, offerId, participantId,
    fromState, toState, timestamp, actorType, actorId, metadataHash,
  };
}

export interface EvidenceCounts {
  w0: number; w1: number; w2a: number; w2b: number; w3: number; w4: number;
  totalResponses: number; offersPresented: number; offersViewed: number;
  accepted: number; declined: number; unavailable: number; ignored: number;
  tripStarted: number; tripCompleted: number; tripCancelled: number;
  acceptanceRate: number | null; completionRate: number | null;
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
