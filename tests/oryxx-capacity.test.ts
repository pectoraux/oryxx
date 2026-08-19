// ORYXX — Capacity evidence layer tests.
//
// Verifies the evidence-tier separation: observed movement ≠ observed capacity ≠
// observed willingness. Tests the NPD-Movement / NPD-Capacity / NPD-Willingness
// model and the NYC taxi provider with real passenger_count data.
//
// Run with: bun test tests/oryxx-capacity.test.ts

import { test, expect, describe } from "bun:test";
import { runCapacityExperiment } from "../src/lib/oryxx/real/evidence/engine";
import { buildNycNpdMovements } from "../src/lib/oryxx/real/providers/nyc-taxi";
import { buildNpdCapacity, buildNpdWillingness } from "../src/lib/oryxx/real/evidence/engine";
import type { CapacityExperimentConfig } from "../src/lib/oryxx/real/evidence/types";
import { NYC_TAXI_SOURCE } from "../src/lib/oryxx/real/providers/nyc-taxi";

const DEFAULT_CONFIG: CapacityExperimentConfig = {
  seed: 42, numDemands: 100, detourToleranceKm: 3.0, minCompensation: 3.0,
  willingness: 0.15, executionProbability: 0.45, pilot: "nyc-taxi",
};

describe("ORYXX capacity evidence layer", () => {
  // === 1. NYC taxi data loads with observed passenger_count ===
  test("NYC taxi movements have OBSERVED occupancy (passenger_count)", () => {
    const movements = buildNycNpdMovements();
    expect(movements.length).toBeGreaterThan(400);
    // every movement should have observedOccupancy.level = "observed" (NYC TLC has passenger_count)
    for (const m of movements) {
      expect(m.observedOccupancy.level).toBe("observed");
      expect(m.vehicleType.value).toBe("taxi");
      expect(m.vehicleType.level).toBe("observed");
      expect(m.source.isFixture).toBe(false); // REAL data
    }
  });

  // === 2. NPD-Capacity correctly classifies Tier B (observed) vs Tier C (inferred) ===
  test("buildNpdCapacity classifies observed capacity as Tier B", () => {
    const movements = buildNycNpdMovements();
    const m = movements[0];
    const cap = buildNpdCapacity(m, NYC_TAXI_SOURCE);
    // NYC data has passenger_count → Tier B (observed)
    expect(cap.tier).toBe("B-observed");
    expect(cap.occupied.level).toBe("observed");
    expect(cap.spare.level).toBe("observed");
    // spare = 4 - passenger_count
    if (m.observedOccupancy.value != null) {
      expect(cap.spare.value).toBe(Math.max(0, 4 - m.observedOccupancy.value));
    }
  });

  // === 3. NPD-Willingness is always Tier E (assumed) in current pilot ===
  test("buildNpdWillingness classifies as Tier E (assumed)", () => {
    const wil = buildNpdWillingness("CAP-1", DEFAULT_CONFIG);
    expect(wil.tier).toBe("E-assumed");
    expect(wil.willingness.level).toBe("assumed");
    expect(wil.executionProbability.level).toBe("assumed");
    expect(wil.detourToleranceKm.level).toBe("assumed");
    expect(wil.minCompensation.level).toBe("assumed");
    expect(wil.reliability.level).toBe("assumed");
  });

  // === 4. Evidence classification: MOVEMENT+CAPACITY observed, willingness assumed ===
  test("opportunities are classified as MOVEMENT+CAPACITY (not FULL-EVIDENCE)", () => {
    const result = runCapacityExperiment(DEFAULT_CONFIG);
    // Tier D (observed willingness) = 0 → no FULL-EVIDENCE opportunities
    expect(result.tierD_observedWillingness).toBe(0);
    expect(result.opportunities.fullEvidence).toBe(0);
    // but MOVEMENT+CAPACITY should exist (movement + capacity are observed)
    if (result.robustOpportunitiesWithObservedCapacity > 0) {
      expect(result.opportunities.movementPlusCapacity).toBeGreaterThan(0);
    }
  });

  // === 5. Observed capacity ≠ 0 for NYC data ===
  test("NYC taxi data has observed spare capacity (passenger_count < 4)", () => {
    const result = runCapacityExperiment(DEFAULT_CONFIG);
    expect(result.totalMovements).toBeGreaterThan(400);
    expect(result.movementsWithObservedCapacity).toBeGreaterThan(400);
    expect(result.movementsWithObservedSpare).toBeGreaterThan(400);
    // all movements have Tier B (observed capacity) since NYC has passenger_count
    expect(result.tierB_observedCapacity).toBeGreaterThan(400);
    expect(result.tierC_inferredCapacity).toBe(0); // no inferred capacity in NYC data
  });

  // === 6. Value tiers: potential > expected > executed ===
  test("value tiers separate potential, expected, and executed", () => {
    const result = runCapacityExperiment(DEFAULT_CONFIG);
    expect(result.potentialValue).toBeGreaterThanOrEqual(result.expectedValue);
    expect(result.expectedValue).toBeGreaterThanOrEqual(result.executedValue);
  });

  // === 7. Top opportunities show evidence trail ===
  test("top opportunities show evidence classification and reason", () => {
    const result = runCapacityExperiment(DEFAULT_CONFIG);
    if (result.topOpportunities.length > 0) {
      const o = result.topOpportunities[0];
      expect(o.evidenceScore.classification).toBeDefined();
      expect(o.evidenceScore.movementObserved).toBe(true);
      expect(o.evidenceScore.capacityObserved).toBe(true);
      expect(o.evidenceScore.willingnessObserved).toBe(false); // Tier E
      expect(o.evidenceScore.observedTiers).toBe(2); // movement + capacity
      expect(o.reasonOrdinaryWouldMiss.length).toBeGreaterThan(0);
      expect(o.reasonOrdinaryWouldMiss).toContain("ASSUMED");
    }
  });

  // === 8. Deterministic replay ===
  test("same config produces same results", () => {
    const r1 = runCapacityExperiment(DEFAULT_CONFIG);
    const r2 = runCapacityExperiment(DEFAULT_CONFIG);
    expect(r1.totalMovements).toBe(r2.totalMovements);
    expect(r1.robustOpportunitiesWithObservedCapacity).toBe(r2.robustOpportunitiesWithObservedCapacity);
    expect(r1.potentialValue).toBe(r2.potentialValue);
  });

  // === 9. Privacy: no raw PII in movements ===
  test("no PII exposed in NYC taxi movements", () => {
    const movements = buildNycNpdMovements();
    for (const m of movements) {
      expect(m.anonymized).toBe(true);
      expect((m as any).driver_name).toBeUndefined();
      expect((m as any).license_plate).toBeUndefined();
      expect((m as any).medallion).toBeUndefined();
    }
  });

  // === 10. Caveats are present and honest ===
  test("caveats mention the critical willingness gap", () => {
    const result = runCapacityExperiment(DEFAULT_CONFIG);
    expect(result.caveats.length).toBeGreaterThan(3);
    const hasWillingnessGap = result.caveats.some((c) => c.toLowerCase().includes("willingness") && c.toLowerCase().includes("assumed"));
    expect(hasWillingnessGap).toBe(true);
    const hasCapacityNotSupply = result.caveats.some((c) => c.toLowerCase().includes("observed capacity") || c.toLowerCase().includes("dispatched trip") || c.toLowerCase().includes("bookable"));
    expect(hasCapacityNotSupply).toBe(true);
  });
});
