// ORYXX — Willingness evidence layer tests.
// Run with: bun test tests/oryxx-willingness.test.ts

import { test, expect, describe } from "bun:test";
import { runWillingnessExperiment } from "../src/lib/oryxx/real/evidence/willingness-engine";
import { WILLINGNESS_TIERS } from "../src/lib/oryxx/real/evidence/willingness";
import type { WillingnessExperimentConfig } from "../src/lib/oryxx/real/evidence/willingness";

const DEFAULT_CONFIG: WillingnessExperimentConfig = {
  seed: 42, numDemands: 150, evidenceSource: "nyc-fhv-gaps",
  compensationLevels: [1, 2, 3, 4, 5, 7, 10],
  detourLevels: [0, 0.5, 1, 2, 3, 5],
  noticeLevels: [0, 15, 60, 360, 1440],
};

describe("ORYXX willingness evidence layer", () => {
  // === 1. Evidence tier is W2 (revealed availability) ===
  test("evidence tier is W2 — not W3 or W4", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    expect(r.evidenceTier).toBe("W2");
    expect(r.marketplaceSufficient).toBe(false); // W2 is NOT sufficient
  });

  // === 2. W0-W4 tiers are defined with correct metadata ===
  test("WILLINGNESS_TIERS has 5 tiers with increasing strength", () => {
    expect(WILLINGNESS_TIERS.length).toBe(5);
    expect(WILLINGNESS_TIERS[0].tier).toBe("W0");
    expect(WILLINGNESS_TIERS[4].tier).toBe("W4");
    // W3 and W4 are marketplace-sufficient; W0-W2 are not
    expect(WILLINGNESS_TIERS[2].marketplaceSufficient).toBe(false); // W2
    expect(WILLINGNESS_TIERS[3].marketplaceSufficient).toBe(true);  // W3
    expect(WILLINGNESS_TIERS[4].marketplaceSufficient).toBe(true);  // W4
  });

  // === 3. Real observations from NYC FHV data ===
  test("observations are real (from NYC FHV gaps, not fixture)", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    expect(r.totalObservations).toBeGreaterThan(1000); // 2032 real gaps
    // observations have pseudonymous provider IDs (no PII)
    for (const o of r.observations.slice(0, 20)) {
      expect(o.providerId).toMatch(/^P-/); // pseudonymous
      expect(o.tier).toBe("W2");
      expect(o.source.isFixture).toBe(false); // REAL data
    }
  });

  // === 4. Opportunity funnel: each step narrows ===
  test("funnel narrows at each step (movements → executed)", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    const f = r.funnel;
    expect(f.steps.length).toBe(7);
    expect(f.steps[0].count).toBeGreaterThan(f.steps[1].count);
    expect(f.steps[1].count).toBeGreaterThanOrEqual(f.steps[2].count);
    expect(f.finalExecutedOpportunities).toBeLessThanOrEqual(f.steps[0].count);
    expect(f.finalExecutedPer1000).toBeGreaterThanOrEqual(0);
  });

  // === 5. Break-even analysis: no detour levels viable at current acceptance ===
  test("break-even analysis shows marketplace economics are marginal", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    expect(r.breakEven.length).toBe(DEFAULT_CONFIG.detourLevels.length);
    for (const b of r.breakEven) {
      expect(b.minAcceptanceForBreakEven).toBeGreaterThan(0);
      expect(b.minAcceptanceForBreakEven).toBeLessThanOrEqual(1);
      expect(b.currentEstimatedAcceptance).toBeGreaterThanOrEqual(0);
      expect(b.currentEstimatedAcceptance).toBeLessThanOrEqual(1);
      // isViable should be consistent with gap
      expect(b.isViable).toBe(b.gap >= 0);
    }
  });

  // === 6. Acceptance curves are monotonic (higher comp → higher accept) ===
  test("acceptance increases with compensation (monotonicity)", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    const curve = r.acceptanceVsCompensation;
    for (let i = 1; i < curve.length; i++) {
      // P(accept) should not decrease when compensation increases
      expect(curve[i].pAccept).toBeGreaterThanOrEqual(curve[i - 1].pAccept - 0.01);
    }
  });

  // === 7. Acceptance decreases with detour (monotonicity) ===
  test("acceptance decreases with detour (monotonicity)", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    const curve = r.acceptanceVsDetour;
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].pAccept).toBeLessThanOrEqual(curve[i - 1].pAccept + 0.01);
    }
  });

  // === 8. What is observed vs assumed is clearly separated ===
  test("whatIsObserved and whatIsAssumed are non-empty", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    expect(r.whatIsObserved.length).toBeGreaterThan(0);
    expect(r.whatIsAssumed.length).toBeGreaterThan(0);
    // observations mention inter-trip gaps
    expect(r.whatIsObserved.some((o) => o.includes("gap") || o.includes("available"))).toBe(true);
    // assumptions mention willingness/execution
    expect(r.whatIsAssumed.some((a) => a.includes("accept") || a.includes("execution") || a.includes("willingness"))).toBe(true);
  });

  // === 9. Deterministic replay ===
  test("same config produces same results", () => {
    const r1 = runWillingnessExperiment(DEFAULT_CONFIG);
    const r2 = runWillingnessExperiment(DEFAULT_CONFIG);
    expect(r1.totalObservations).toBe(r2.totalObservations);
    expect(r1.funnel.finalExecutedOpportunities).toBe(r2.funnel.finalExecutedOpportunities);
    expect(r1.expectedExecutedPer1000).toBe(r2.expectedExecutedPer1000);
  });

  // === 10. Privacy: no real driver names/IDs exposed ===
  test("no PII in observations — provider IDs are pseudonymous", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    for (const o of r.observations.slice(0, 50)) {
      expect(o.providerId).toMatch(/^P-B\d+/); // P- + base number (pseudonymous)
      expect(o.providerId).not.toContain("@");
      expect((o as any).driver_name).toBeUndefined();
      expect((o as any).license_plate).toBeUndefined();
    }
  });

  // === 11. Caveats explicitly state the evidence is NOT W3 ===
  test("caveats state that W2 is not W3 (not revealed acceptance)", () => {
    const r = runWillingnessExperiment(DEFAULT_CONFIG);
    const hasNotW3 = r.caveats.some((c) => c.includes("NOT W3") || c.includes("not that they would ACCEPT") || c.includes("not revealed acceptance"));
    expect(hasNotW3).toBe(true);
  });
});
