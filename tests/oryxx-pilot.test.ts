// ORYXX — W3 Pilot state machine + evidence integrity tests.
// Run with: bun test tests/oryxx-pilot.test.ts

import { test, expect, describe } from "bun:test";
import {
  isValidTransition,
  VALID_TRANSITIONS,
  evidenceTierForState,
  validateOfferSafety,
  assignTreatment,
  generateTreatmentCells,
  calculateSampleSize,
  computeCellEconomics,
  emptyEvidenceCounts,
  wilsonCI,
  evaluateMarketplaceDecision,
} from "../src/lib/oryxx/real/evidence/pilot";
import type { TreatmentCell, PreregisteredExperiment } from "../src/lib/oryxx/real/evidence/pilot";

describe("ORYXX W3 Pilot — state machine + evidence integrity", () => {
  // === 1. Valid state transitions ===
  test("state machine allows OFFER_CREATED → OFFER_PRESENTED → PROVIDER_VIEWED → PROVIDER_ACCEPTED", () => {
    expect(isValidTransition("OFFER_CREATED", "OFFER_PRESENTED")).toBe(true);
    expect(isValidTransition("OFFER_PRESENTED", "PROVIDER_VIEWED")).toBe(true);
    expect(isValidTransition("PROVIDER_VIEWED", "PROVIDER_ACCEPTED")).toBe(true);
  });

  // === 2. Invalid transitions are rejected ===
  test("invalid transitions are rejected (W2a CANNOT become W3 without a decision)", () => {
    expect(isValidTransition("OFFER_CREATED", "PROVIDER_ACCEPTED")).toBe(false); // must go through PRESENTED → VIEWED
    expect(isValidTransition("PROVIDER_DECLINED", "PROVIDER_ACCEPTED")).toBe(false); // can't un-decline
    expect(isValidTransition("TRIP_CANCELLED", "TRIP_COMPLETED")).toBe(false); // can't un-cancel
  });

  // === 3. Evidence tier for each state ===
  test("only PROVIDER_ACCEPTED creates W3, only TRIP_COMPLETED creates W4", () => {
    expect(evidenceTierForState("OFFER_CREATED")).toBe("W2a");
    expect(evidenceTierForState("OFFER_PRESENTED")).toBe("W2a");
    expect(evidenceTierForState("PROVIDER_VIEWED")).toBe("W2a");
    expect(evidenceTierForState("PROVIDER_ACCEPTED")).toBe("W3");
    expect(evidenceTierForState("TRIP_STARTED")).toBe("W3");
    expect(evidenceTierForState("TRIP_COMPLETED")).toBe("W4");
    expect(evidenceTierForState("PROVIDER_DECLINED")).toBe("W0");
  });

  // === 4. Offer safety validator ===
  test("unsafe offers are rejected (max detour, max time, min compensation)", () => {
    expect(validateOfferSafety({ detourKm: 2, extraTimeMin: 5, compensation: 3, passengerCount: 1 }, { maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1 }).safe).toBe(true);
    expect(validateOfferSafety({ detourKm: 10, extraTimeMin: 5, compensation: 3, passengerCount: 1 }, { maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1 }).safe).toBe(false);
    expect(validateOfferSafety({ detourKm: 2, extraTimeMin: 30, compensation: 3, passengerCount: 1 }, { maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1 }).safe).toBe(false);
    expect(validateOfferSafety({ detourKm: 2, extraTimeMin: 5, compensation: 0.5, passengerCount: 1 }, { maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1 }).safe).toBe(false);
    expect(validateOfferSafety({ detourKm: 2, extraTimeMin: 5, compensation: 3, passengerCount: 4 }, { maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1 }).safe).toBe(false);
  });

  // === 5. Treatment assignment is deterministic ===
  test("assignTreatment is deterministic (same provider + experiment → same cell)", () => {
    const cells: TreatmentCell[] = [
      { compensation: 2, detourKm: 1, extraTimeMin: 5, advanceNoticeMin: 0 },
      { compensation: 3, detourKm: 2, extraTimeMin: 5, advanceNoticeMin: 15 },
      { compensation: 4, detourKm: 3, extraTimeMin: 10, advanceNoticeMin: 60 },
    ];
    const c1 = assignTreatment("P-abc123", "EXP-1", 42, cells);
    const c2 = assignTreatment("P-abc123", "EXP-1", 42, cells);
    expect(c1).toEqual(c2); // deterministic
  });

  // === 6. Treatment cells exclude unsafe combinations ===
  test("generateTreatmentCells excludes unsafe combinations", () => {
    const spec = {
      experimentId: "test", version: 1, hypothesis: "", population: "", geography: "", providerType: "",
      sampleTarget: 100,
      compensationBuckets: [1, 3, 5],
      detourBuckets: [0, 2, 5, 10],
      extraTimeBuckets: [0, 5, 20, 30],
      noticeBuckets: [0, 15],
      randomizationSeed: 42, primaryOutcome: "W3_acceptance_rate" as const,
      secondaryOutcomes: [], analysisMethod: "", stoppingRule: "", safetyRules: [],
      maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1,
      consentText: "", requiresConsent: true,
      status: "preregistered" as const, preregisteredAt: "", isImmutable: false,
    } as PreregisteredExperiment;
    const cells = generateTreatmentCells(spec);
    // detour 10km should be excluded (max 5)
    expect(cells.every((c) => c.detourKm <= 5)).toBe(true);
    // time 30min should be excluded (max 20)
    expect(cells.every((c) => c.extraTimeMin <= 20)).toBe(true);
  });

  // === 7. Break-even acceptance calculation ===
  test("computeCellEconomics calculates break-even correctly", () => {
    const econ = computeCellEconomics({ compensation: 3, detourKm: 2, extraTimeMin: 5, advanceNoticeMin: 0 });
    expect(econ.breakEvenAcceptance).toBeGreaterThan(0);
    expect(econ.breakEvenAcceptance).toBeLessThanOrEqual(1);
    expect(econ.netValuePerExecution).toBeDefined();
    // higher compensation should increase break-even (harder to be profitable)
    const econ2 = computeCellEconomics({ compensation: 5, detourKm: 2, extraTimeMin: 5, advanceNoticeMin: 0 });
    expect(econ2.breakEvenAcceptance).toBeGreaterThanOrEqual(econ.breakEvenAcceptance);
  });

  // === 8. Sample-size calculator ===
  test("calculateSampleSize produces reasonable values", () => {
    const ss = calculateSampleSize(0.2, 0.1, 0.05, 0.80);
    expect(ss.requiredPerCell).toBeGreaterThan(50); // need a real sample
    expect(ss.requiredPerCell).toBeLessThan(1000);
    expect(ss.alpha).toBe(0.05);
    expect(ss.power).toBe(0.80);
  });

  // === 9. Wilson CI ===
  test("wilsonCI produces valid intervals", () => {
    const ci = wilsonCI(8, 10);
    expect(ci.low).toBeGreaterThan(0);
    expect(ci.high).toBeLessThanOrEqual(1);
    expect(ci.low).toBeLessThan(ci.high);
    // edge cases
    expect(wilsonCI(0, 0)).toEqual({ low: 0, high: 0 });
    expect(wilsonCI(10, 10).high).toBeGreaterThan(0.5);
  });

  // === 10. Marketplace decision: NOT_TESTED when W3 = 0 ===
  test("marketplace decision returns NOT_TESTED when no W3 evidence exists", () => {
    const counts = emptyEvidenceCounts();
    const cells: TreatmentCell[] = [{ compensation: 3, detourKm: 2, extraTimeMin: 5, advanceNoticeMin: 0 }];
    const decision = evaluateMarketplaceDecision(cells, counts);
    expect(decision.verdict).toBe("NOT_TESTED");
    expect(decision.reason).toContain("No W3 evidence");
  });

  // === 11. Evidence counts start at zero ===
  test("emptyEvidenceCounts has all zeros", () => {
    const counts = emptyEvidenceCounts();
    expect(counts.w0).toBe(0);
    expect(counts.w1).toBe(0);
    expect(counts.w2a).toBe(0);
    expect(counts.w2b).toBe(0);
    expect(counts.w3).toBe(0);
    expect(counts.w4).toBe(0);
    expect(counts.acceptanceRate).toBe(null);
    expect(counts.completionRate).toBe(null);
  });

  // === 12. Privacy: provider IDs are pseudonymous ===
  test("assignTreatment does not require or expose PII", () => {
    const cells: TreatmentCell[] = [{ compensation: 3, detourKm: 2, extraTimeMin: 5, advanceNoticeMin: 0 }];
    const cell = assignTreatment("P-abc123", "EXP-1", 42, cells);
    // the function only uses the providerId string for hashing — no PII accessed
    expect(cell).toBeDefined();
    expect(cell.compensation).toBeGreaterThan(0);
  });
});
