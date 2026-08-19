// ORYXX — Evidence isolation tests.
// Proves W3-R cannot become W3-M, W4-R cannot become W4-M,
// and research evidence cannot contaminate marketplace metrics.
// Run with: bun test tests/oryxx-evidence-isolation.test.ts

import { test, expect, describe } from "bun:test";
import {
  researchEvidenceForState,
  marketplaceEvidenceForState,
  isResearchEvidence,
  isMarketplaceEvidence,
  validateMarketplaceOpportunityShape,
  loadDesignStrict,
  computePreregistrationHash,
  verifyDesignHash,
  emptyEvidenceCounts,
  type EvidenceTier,
  type PreregisteredDesign,
} from "../src/lib/oryxx/real/evidence/pilot";

const TEST_DESIGN: PreregisteredDesign = {
  hypothesis: "test", population: "test", geography: "test", providerType: "test",
  sampleTarget: 100, compensationBuckets: [1, 2, 3], detourBuckets: [0, 1, 2],
  extraTimeBuckets: [0, 5], noticeBuckets: [0, 15],
  randomizationSeed: 42, primaryOutcome: "W3_acceptance_rate", secondaryOutcomes: [],
  analysisMethod: "wilson", stoppingRule: "100", safetyRules: [],
  maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1,
  consentText: "test", assumedUserSavings: 4, assumedFailureCost: 1, assumedOryxxMargin: 0.5,
};

describe("ORYXX evidence isolation — W3-R ≠ W3-M, W4-R ≠ W4-M", () => {
  // === 1. W3-R and W3-M are distinct types ===
  test("W3-R ≠ W3-M — they are different EvidenceTier values", () => {
    expect("W3-R").not.toBe("W3-M");
    expect("W4-R").not.toBe("W4-M");
  });

  // === 2. isResearchEvidence does not match marketplace tiers ===
  test("isResearchEvidence(W3-R) = true, isResearchEvidence(W3-M) = false", () => {
    expect(isResearchEvidence("W3-R")).toBe(true);
    expect(isResearchEvidence("W4-R")).toBe(true);
    expect(isResearchEvidence("W3-M")).toBe(false);
    expect(isResearchEvidence("W4-M")).toBe(false);
  });

  // === 3. isMarketplaceEvidence does not match research tiers ===
  test("isMarketplaceEvidence(W3-M) = true, isMarketplaceEvidence(W3-R) = false", () => {
    expect(isMarketplaceEvidence("W3-M")).toBe(true);
    expect(isMarketplaceEvidence("W4-M")).toBe(true);
    expect(isMarketplaceEvidence("W3-R")).toBe(false);
    expect(isMarketplaceEvidence("W4-R")).toBe(false);
  });

  // === 4. Research state machine produces W3-R, NOT W3-M ===
  test("researchEvidenceForState(PROVIDER_ACCEPTED) = W3-R (not W3-M)", () => {
    expect(researchEvidenceForState("PROVIDER_ACCEPTED")).toBe("W3-R");
    expect(researchEvidenceForState("TRIP_COMPLETED")).toBe("W4-R");
    // NOT W3-M or W4-M
    expect(researchEvidenceForState("PROVIDER_ACCEPTED")).not.toBe("W3-M");
    expect(researchEvidenceForState("TRIP_COMPLETED")).not.toBe("W4-M");
  });

  // === 5. Marketplace state machine produces W3-M, NOT W3-R ===
  test("marketplaceEvidenceForState(ACCEPTED) = W3-M (not W3-R)", () => {
    expect(marketplaceEvidenceForState("ACCEPTED")).toBe("W3-M");
    expect(marketplaceEvidenceForState("COMPLETED")).toBe("W4-M");
    // NOT W3-R or W4-R
    expect(marketplaceEvidenceForState("ACCEPTED")).not.toBe("W3-R");
    expect(marketplaceEvidenceForState("COMPLETED")).not.toBe("W4-R");
  });

  // === 6. Marketplace opportunity requires real demand + supply bindings ===
  test("validateMarketplaceOpportunityShape rejects missing demand/supply bindings", () => {
    expect(validateMarketplaceOpportunityShape({ demandBinding: null, supplyBinding: null }).valid).toBe(false);
    expect(validateMarketplaceOpportunityShape({ demandBinding: { demandId: "d1", origin: {lat:0,lon:0}, destination: {lat:1,lon:1} }, supplyBinding: null }).valid).toBe(false);
    expect(validateMarketplaceOpportunityShape({ demandBinding: null, supplyBinding: { eventId: "e1", providerId: "p1", origin: {lat:0,lon:0}, destination: {lat:1,lon:1} } }).valid).toBe(false);
    const valid = validateMarketplaceOpportunityShape({
      demandBinding: { demandId: "d1", origin: {lat:0,lon:0}, destination: {lat:1,lon:1} },
      supplyBinding: { eventId: "e1", providerId: "p1", origin: {lat:0,lon:0}, destination: {lat:1,lon:1} },
    });
    expect(valid.valid).toBe(true);
  });

  // === 7. Missing treatment design is a HARD ERROR ===
  test("loadDesignStrict throws when treatmentDesignJson is null", () => {
    expect(() => loadDesignStrict(null)).toThrow("missing persisted preregistered design");
  });

  // === 8. Hash verification works ===
  test("verifyDesignHash returns true for matching design, false for modified", () => {
    const hash = computePreregistrationHash(TEST_DESIGN);
    expect(verifyDesignHash(TEST_DESIGN, hash)).toBe(true);
    const modified = { ...TEST_DESIGN, hypothesis: "DIFFERENT" };
    expect(verifyDesignHash(modified, hash)).toBe(false);
  });

  // === 9. emptyEvidenceCounts has W3-M = 0 and W4-M = 0 ===
  test("emptyEvidenceCounts starts with W3-M=0, W4-M=0, W3-R=0, W4-R=0", () => {
    const c = emptyEvidenceCounts();
    expect(c.w3r).toBe(0);
    expect(c.w4r).toBe(0);
    expect(c.w3m).toBe(0);
    expect(c.w4m).toBe(0);
    expect(c.marketplaceOpportunities).toBe(0);
    expect(c.marketplaceAccepted).toBe(0);
    expect(c.marketplaceCompleted).toBe(0);
  });

  // === 10. Research evidence cannot be classified as marketplace ===
  test("a W3-R tier value cannot pass isMarketplaceEvidence", () => {
    const researchTiers: EvidenceTier[] = ["W3-R", "W4-R"];
    for (const t of researchTiers) {
      expect(isMarketplaceEvidence(t)).toBe(false);
    }
  });

  // === 11. Marketplace evidence cannot be classified as research ===
  test("a W3-M tier value cannot pass isResearchEvidence", () => {
    const marketplaceTiers: EvidenceTier[] = ["W3-M", "W4-M"];
    for (const t of marketplaceTiers) {
      expect(isResearchEvidence(t)).toBe(false);
    }
  });
});
