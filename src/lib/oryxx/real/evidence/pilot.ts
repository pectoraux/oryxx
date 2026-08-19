// ORYXX — Research-integrity-safe pilot infrastructure (v4).
//
// Splits evidence into RESEARCH (W3-R/W4-R) and MARKETPLACE (W3-M/W4-M) tracks.
// These are structurally separate — a research acceptance can NEVER become
// marketplace evidence, and marketplace evidence requires real demand + supply
// bindings that research stimuli don't have.
//
// Evidence tiers (frozen):
//   NONE, A, B, C, W2a, W2b, W3-R, W4-R, W3-M, W4-M
//
// W3-R = verified provider accepted a controlled research offer (stimulus)
// W4-R = research offer completion (operator/system verified, NOT marketplace)
// W3-M = real provider accepted a real ORYXX marketplace opportunity
// W4-M = marketplace opportunity independently verified as completed
//
// These are NOT interchangeable.

import { createHash } from "crypto";

// =====================================================================
// 1. EVIDENCE TIERS (frozen — no aliases)
// =====================================================================

export type EvidenceTier =
  | "NONE" | "A" | "B" | "C" | "W2a" | "W2b"
  | "W3-R" | "W4-R"   // research track
  | "W3-M" | "W4-M";   // marketplace track

export function isResearchEvidence(tier: EvidenceTier): boolean {
  return tier === "W3-R" || tier === "W4-R";
}

export function isMarketplaceEvidence(tier: EvidenceTier): boolean {
  return tier === "W3-M" || tier === "W4-M";
}

// =====================================================================
// 2. APPLICATION STATE MACHINES (separate for research vs marketplace)
// =====================================================================

export type ResearchState =
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

export type MarketplaceState =
  | "OPPORTUNITY_CREATED"
  | "OFFERED"
  | "ACCEPTED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export const RESEARCH_TRANSITIONS: Record<ResearchState, ResearchState[]> = {
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

export const MARKETPLACE_TRANSITIONS: Record<MarketplaceState, MarketplaceState[]> = {
  OPPORTUNITY_CREATED: ["OFFERED"],
  OFFERED: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isValidResearchTransition(from: ResearchState, to: ResearchState): boolean {
  return (RESEARCH_TRANSITIONS[from] ?? []).includes(to);
}

export function isValidMarketplaceTransition(from: MarketplaceState, to: MarketplaceState): boolean {
  return (MARKETPLACE_TRANSITIONS[from] ?? []).includes(to);
}

// =====================================================================
// 3. EVIDENCE TIER FROM STATE (research vs marketplace)
// =====================================================================

export function researchEvidenceForState(state: ResearchState): EvidenceTier {
  switch (state) {
    case "PROVIDER_ACCEPTED":
    case "TRIP_STARTED":
      return "W3-R"; // research acceptance
    case "TRIP_COMPLETED":
      return "W4-R"; // research completion
    default:
      return "NONE"; // application states do NOT produce evidence
  }
}

export function marketplaceEvidenceForState(state: MarketplaceState): EvidenceTier {
  switch (state) {
    case "ACCEPTED":
    case "EXECUTING":
      return "W3-M"; // marketplace acceptance
    case "COMPLETED":
      return "W4-M"; // marketplace completion
    default:
      return "NONE";
  }
}

// =====================================================================
// 4. PROVIDER VERIFICATION LEVELS
// =====================================================================

export type ProviderVerificationStatus =
  | "unverified"
  | "operator_verified"   // admin verified (weaker)
  | "externally_verified"; // external evidence (stronger)

export type CompletionEvidenceLevel =
  | "none"
  | "operator"      // admin clicked "completed" (weakest)
  | "system"       // system-verified (e.g. app log)
  | "gps"          // GPS/telemetry verified
  | "provider_api"; // external provider API confirmed

// =====================================================================
// 5. PREREGISTRATION (immutable after ACTIVE, with hash + validation)
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
  assumedUserSavings: number;
  assumedFailureCost: number;
  assumedOryxxMargin: number;
}

export function computePreregistrationHash(design: PreregisteredDesign): string {
  const canonical = JSON.stringify(design, Object.keys(design).sort());
  return createHash("sha256").update(canonical).digest("hex"); // FULL SHA-256
}

export function canMutateDesign(status: ExperimentStatus): boolean {
  return status === "DRAFT" || status === "PREREGISTERED";
}

// STRICT: load design from DB or throw (no fallback)
export function loadDesignStrict(treatmentDesignJson: string | null): PreregisteredDesign {
  if (!treatmentDesignJson) {
    throw new Error("ACTIVE experiment missing persisted preregistered design. This is a hard error — no fallback allowed.");
  }
  try {
    return JSON.parse(treatmentDesignJson);
  } catch (e) {
    throw new Error("Corrupted treatmentDesignJson — cannot parse persisted design.");
  }
}

// Verify hash matches at runtime
export function verifyDesignHash(design: PreregisteredDesign, expectedHash: string): boolean {
  return computePreregistrationHash(design) === expectedHash;
}

// =====================================================================
// 6. BALANCED RANDOMIZATION (concurrency-safe via least-filled)
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
            compensation: comp, detourKm: detour, extraTimeMin: time, advanceNoticeMin: notice,
          });
        }
      }
    }
  }
  return cells;
}

// Least-filled cell assignment with deterministic tiebreak
export function assignTreatment(
  participantId: string,
  experimentId: string,
  seed: number,
  cells: TreatmentCell[],
  cellCounts: number[],
): TreatmentCell {
  if (cells.length === 0) throw new Error("No treatment cells available");
  const minCount = Math.min(...cellCounts);
  const candidates: number[] = [];
  for (let i = 0; i < cellCounts.length; i++) {
    if (cellCounts[i] === minCount) candidates.push(i);
  }
  const hash = [...participantId + experimentId].reduce((a, c) => a * 31 + c.charCodeAt(0), seed);
  return cells[candidates[Math.abs(hash) % candidates.length]];
}

// =====================================================================
// 7. OFFER SAFETY VALIDATION
// =====================================================================

export interface OfferSafetyCheck { safe: boolean; violations: string[]; }

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

export function isOfferExpired(offerPresentedAt: string | null, expiresAfterMin: number = 30): boolean {
  if (!offerPresentedAt) return false;
  return Date.now() > new Date(offerPresentedAt).getTime() + expiresAfterMin * 60 * 1000;
}

// =====================================================================
// 8. MARKETPLACE OPPORTUNITY (requires real demand + supply bindings)
// =====================================================================

export interface TransportationEventBinding {
  eventId: string;
  source: string;          // "nyc-tlc" | "osm" | "provider-api" | etc.
  providerId: string;
  mode: string;
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  plannedDeparture: string;
  plannedArrival: string;
  currentStatus: string;
  capacityEvidence: EvidenceTier;  // B (observed) or C (inferred)
  supplyEvidence: EvidenceTier;   // W2a (not-on-trip) etc.
  externalReference: string;
}

export interface DemandBinding {
  demandId: string;
  source: string;
  requestType: string;     // "person" | "parcel" | etc.
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  timeWindow: { start: string; end: string };
  partySize: number;
  objectType: string;
  status: string;
  externalReference: string;
}

export interface MarketplaceOpportunity {
  id: string;
  demandBinding: DemandBinding;
  supplyBinding: TransportationEventBinding;
  providerId: string;
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  departureWindow: { start: string; end: string };
  arrivalWindow: { start: string; end: string };
  capacity: number;
  price: number;
  detourKm: number;
  extraTimeMin: number;
  isMarketplaceOpportunity: true;  // always true — distinguishes from research stimulus
  state: MarketplaceState;
  evidenceTier: EvidenceTier;
  completionEvidenceLevel: CompletionEvidenceLevel;
  source: string;
  executionPlan: string;
}

// W3-M CANNOT be created without valid demand + supply bindings
// Structural validation only — does NOT verify external truth
export function validateMarketplaceOpportunityShape(opp: {
  demandBinding: any;
  supplyBinding: any;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!opp.demandBinding?.demandId) errors.push("Missing demand binding");
  if (!opp.demandBinding?.origin) errors.push("Missing demand origin");
  if (!opp.demandBinding?.destination) errors.push("Missing demand destination");
  if (!opp.supplyBinding?.eventId) errors.push("Missing supply/event binding");
  if (!opp.supplyBinding?.providerId) errors.push("Missing supply provider");
  if (!opp.supplyBinding?.origin) errors.push("Missing supply origin");
  if (!opp.supplyBinding?.destination) errors.push("Missing supply destination");
  return { valid: errors.length === 0, errors };
}

// Evidence verification — CANNOT succeed until real provider integrations exist
export function verifyMarketplaceOpportunityEvidence(): { verified: boolean; reason: string } {
  return {
    verified: false,
    reason: "NOT_IMPLEMENTED — no real provider integration exists. Structural shape can be validated, but external truth cannot be verified. W3-M/W4-M evidence creation is impossible until a real provider API is connected.",
  };
}

// =====================================================================
// 9. SAMPLE-SIZE CALCULATOR
// =====================================================================

export interface SampleSizeResult {
  requiredPerCell: number;
  totalRequired: number;
  numCells: number;
  alpha: number; power: number; baseline: number; minDetectableLift: number;
  formula: string;
}

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
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, z: number;
  if (p < pLow) { q = Math.sqrt(-2 * Math.log(p)); z = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  else if (p <= pHigh) { q = p - 0.5; const r = q*q; z = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+b[5]); }
  else { q = Math.sqrt(-2 * Math.log(1-p)); z = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  return z;
}

export function calculateSampleSize(baseline: number, minDetectableLift: number, alpha: number = 0.05, power: number = 0.80, numCells: number = 1): SampleSizeResult {
  const zAlpha = zScore(1 - alpha / 2);
  const zBeta = zScore(power);
  const p1 = baseline, p2 = baseline + minDetectableLift, pBar = (p1 + p2) / 2;
  const n = Math.ceil(((zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) / (p2 - p1) ** 2);
  return { requiredPerCell: n, totalRequired: n * numCells, numCells, alpha, power, baseline, minDetectableLift, formula: `n = ceil((z_α(${zAlpha.toFixed(3)})·√(2p̄(1-p̄)) + z_β(${zBeta.toFixed(3)})·√(p₁(1-p₁)+p₂(1-p₂)))² / (p₂-p₁)²) = ${n}, total = ${n}×${numCells} = ${n * numCells}` };
}

// =====================================================================
// 10. PER-CELL ECONOMICS + BREAK-EVEN
// =====================================================================

export interface CellEconomics {
  cell: TreatmentCell;
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
  const breakEven = failureCost / Math.max(0.001, userSavings - supplierCompensation - oryxxMargin + failureCost);
  return { cell, assumedUserSavings: userSavings, supplierCompensation, supplierCost, oryxxMargin, failureCost, breakEvenAcceptance: Math.round(breakEven * 1000) / 1000, netValuePerExecution: Math.round((userSavings - supplierCompensation - oryxxMargin - supplierCost) * 100) / 100 };
}

// =====================================================================
// 11. PER-CELL RESULTS + WILSON CI
// =====================================================================

export interface CellResult {
  cell: TreatmentCell; economics: CellEconomics;
  offers: number; viewed: number; accepted: number; declined: number; unavailable: number; ignored: number;
  started: number; completed: number; cancelled: number;
  acceptanceRate: number | null; completionRate: number | null;
  acceptanceCI95: { low: number; high: number } | null; completionCI95: { low: number; high: number } | null;
}

export function wilsonCI(accepts: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = zScore(0.975);
  const p = accepts / total;
  const denom = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / denom;
  return { low: Math.round(Math.max(0, center - margin) * 1000) / 1000, high: Math.round(Math.min(1, center + margin) * 1000) / 1000 };
}

// =====================================================================
// 12. MARKETPLACE DECISION RULE (per-cell, preregistered)
// =====================================================================

export type MarketplaceVerdict = "NOT_TESTED" | "TESTED_NEGATIVE" | "TESTED_INCONCLUSIVE" | "TESTED_PROMISING";

export interface MarketplaceDecision {
  verdict: MarketplaceVerdict;
  viableCells: number;
  cellResults: { cellId: string; verdict: MarketplaceVerdict; reason: string }[];
  reason: string;
}

export function evaluateMarketplaceDecision(cellResults: CellResult[], minSamplePerCell: number): MarketplaceDecision {
  if (cellResults.every((c) => c.offers === 0)) return { verdict: "NOT_TESTED", viableCells: 0, cellResults: [], reason: "No W3-R evidence exists." };
  const cellVerdicts = cellResults.map((cr) => {
    if (cr.offers < minSamplePerCell) return { cellId: cr.cell.id, verdict: "TESTED_INCONCLUSIVE" as MarketplaceVerdict, reason: `n=${cr.offers} < min=${minSamplePerCell}` };
    const acc = cr.acceptanceRate ?? 0, comp = cr.completionRate ?? 0, econ = cr.economics;
    if (acc >= econ.breakEvenAcceptance && comp > 0.5 && econ.netValuePerExecution > 0) return { cellId: cr.cell.id, verdict: "TESTED_PROMISING" as MarketplaceVerdict, reason: `acc=${Math.round(acc*100)}% ≥ break-even, comp=${Math.round(comp*100)}%, net=$${econ.netValuePerExecution}` };
    return { cellId: cr.cell.id, verdict: "TESTED_NEGATIVE" as MarketplaceVerdict, reason: `acc=${Math.round(acc*100)}% < break-even=${Math.round(econ.breakEvenAcceptance*100)}% OR comp≤50% OR net≤0` };
  });
  const viable = cellVerdicts.filter((v) => v.verdict === "TESTED_PROMISING");
  return { verdict: viable.length > 0 ? "TESTED_PROMISING" : cellVerdicts.every(v => v.verdict === "TESTED_INCONCLUSIVE") ? "TESTED_INCONCLUSIVE" : "TESTED_NEGATIVE", viableCells: viable.length, cellResults: cellVerdicts, reason: viable.length > 0 ? `${viable.length} cell(s) viable.` : "No cell viable." };
}

// =====================================================================
// 13. EVENT LOG
// =====================================================================

export interface ExperimentEvent {
  id: string; experimentId: string; offerId: string; participantId: string;
  fromState: string | null; toState: string; timestamp: string;
  actorType: "system" | "participant" | "admin"; actorId: string; metadataHash: string;
  // tamper-evident hash chain
  eventHash: string;
  previousEventHash: string | null;
}

export function createEvent(
  experimentId: string, offerId: string, participantId: string,
  fromState: string | null, toState: string,
  actorType: "system" | "participant" | "admin", actorId: string,
  previousEventHash: string | null = null, // for hash chain
): ExperimentEvent {
  const timestamp = new Date().toISOString();
  const payload = `${experimentId}|${offerId}|${participantId}|${fromState}|${toState}|${timestamp}|${actorType}|${actorId}`;
  const metadataHash = createHash("sha256").update(payload).digest("hex").substring(0, 16);
  // hash chain: event_n.hash = SHA256(payload + event_{n-1}.hash)
  const eventHash = createHash("sha256").update(payload + (previousEventHash ?? "")).digest("hex");
  return {
    id: `EVT-${createHash("sha256").update(payload + Math.random()).digest("hex").substring(0, 12)}`,
    experimentId, offerId, participantId,
    fromState, toState, timestamp, actorType, actorId,
    metadataHash, eventHash, previousEventHash,
  };
}

// =====================================================================
// 14. EVIDENCE COUNTS (research vs marketplace separated)
// =====================================================================

export interface EvidenceCounts {
  // research track
  w3r: number; w4r: number;
  // marketplace track (always 0 until real marketplace exists)
  w3m: number; w4m: number;
  // lower tiers
  w2a: number; w2b: number;
  // funnel
  totalResponses: number; offersPresented: number; offersViewed: number;
  accepted: number; declined: number; unavailable: number; ignored: number;
  tripStarted: number; tripCompleted: number; tripCancelled: number;
  acceptanceRate: number | null; completionRate: number | null;
  acceptanceCI95: { low: number; high: number } | null;
  completionCI95: { low: number; high: number } | null;
  // marketplace (always 0 until W3-M exists)
  marketplaceOpportunities: number;
  marketplaceAccepted: number;
  marketplaceCompleted: number;
}

export function emptyEvidenceCounts(): EvidenceCounts {
  return {
    w3r: 0, w4r: 0, w3m: 0, w4m: 0, w2a: 0, w2b: 0,
    totalResponses: 0, offersPresented: 0, offersViewed: 0,
    accepted: 0, declined: 0, unavailable: 0, ignored: 0,
    tripStarted: 0, tripCompleted: 0, tripCancelled: 0,
    acceptanceRate: null, completionRate: null,
    acceptanceCI95: null, completionCI95: null,
    marketplaceOpportunities: 0, marketplaceAccepted: 0, marketplaceCompleted: 0,
  };
}
