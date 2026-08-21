// ORYXX — Citi Bike NYC Provider Adapter Tests.
//
// Tests the real Citi Bike NYC adapter (CityBik.es API).
// These tests make REAL API calls to api.citybik.es — they verify
// that the adapter correctly observes real supply data.
//
// Classification: OBSERVED_ONLY
// - Real supply discovery: YES (real API data)
// - Acceptance/execution: NOT_SUPPORTED (verified by tests)
// - W3-M/W4-M: CANNOT be produced (verified by tests)

import { test, expect, describe } from "bun:test";
import { CitiBikeNYCProvider } from "../src/lib/oryxx/live/adapters/citibike-provider";
import { canProduceMarketplaceEvidence, MARKETPLACE_EVIDENCE_RULES } from "../src/lib/oryxx/live/types";
import type { TransportationExecution } from "../src/lib/oryxx/live/types";

const NYC_CENTER = { lat: 40.7589, lon: -73.9851 }; // Times Square

describe("Citi Bike NYC Provider Adapter — OBSERVED_ONLY", () => {

  // ─── PROVIDER IDENTITY ────────────────────────────────────────────
  test("provider identity is OBSERVED_ONLY", () => {
    const provider = new CitiBikeNYCProvider();
    const identity = provider.getProviderIdentity();
    expect(identity.providerId).toBe("citi-bike-nyc");
    expect(identity.environment).toBe("OBSERVED_ONLY");
    expect(identity.connectionStatus).toBe("OBSERVED_ONLY");
  });

  test("provider provenance declares OBSERVED_ONLY with no execution capability", () => {
    const provider = new CitiBikeNYCProvider();
    const provenance = provider.getProvenance();
    expect(provenance.environment).toBe("OBSERVED_ONLY");
    expect(provenance.executionCapable).toBe(false);
    expect(provenance.acceptanceCapable).toBe(false);
    expect(provenance.completionVerificationCapable).toBe(false);
    expect(provenance.coverage).toBe("New York, NY, US");
    expect(provenance.dataSource).toContain("citybik.es");
  });

  test("capabilities are all false (observed-only)", () => {
    const provider = new CitiBikeNYCProvider();
    const caps = provider.getCapabilities();
    expect(caps.quotes).toBe(false);
    expect(caps.reservation).toBe(false);
    expect(caps.dispatch).toBe(false);
    expect(caps.tracking).toBe(false);
    expect(caps.completion).toBe(false);
    expect(caps.payments).toBe(false);
  });

  // ─── UNSUPPORTED OPERATIONS ────────────────────────────────────────
  test("accept returns NOT_SUPPORTED", async () => {
    const provider = new CitiBikeNYCProvider();
    const result = await provider.accept("any-offer-id");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("NOT_SUPPORTED");
  });

  test("acceptOffer returns NOT_SUPPORTED", async () => {
    const provider = new CitiBikeNYCProvider();
    const result = await provider.acceptOffer("offer-id", "idempotency-key");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("NOT_SUPPORTED");
  });

  test("startExecution returns NOT_STARTED", async () => {
    const provider = new CitiBikeNYCProvider();
    const result = await provider.startExecution("any-id");
    expect(result.started).toBe(false);
  });

  test("verifyCompletion returns NOT_VERIFIED", async () => {
    const provider = new CitiBikeNYCProvider();
    const result = await provider.verifyCompletion("any-id");
    expect(result.verified).toBe(false);
  });

  test("quote returns null (no pricing API)", async () => {
    const provider = new CitiBikeNYCProvider();
    const result = await provider.quote({} as any);
    expect(result).toBeNull();
  });

  test("reserve returns null (no reservation API)", async () => {
    const provider = new CitiBikeNYCProvider();
    const result = await provider.reserve({} as any);
    expect(result).toBeNull();
  });

  // ─── HEALTH CHECK (real API) ──────────────────────────────────────
  test("health check connects to real CityBik.es API", async () => {
    const provider = new CitiBikeNYCProvider();
    const health = await provider.healthCheck();
    expect(health.connected).toBe(true);
    expect(health.stationCount).toBeGreaterThan(100); // Citi Bike has 2000+ stations
    expect(health.error).toBeNull();
    expect(health.latencyMs).toBeGreaterThan(0);
    expect(health.latencyMs).toBeLessThan(30000); // under 30s
  });

  // ─── REAL SUPPLY DISCOVERY ────────────────────────────────────────
  test("discovers real Citi Bike stations near NYC center", async () => {
    const provider = new CitiBikeNYCProvider();
    const supplies = await provider.discoverSupply(NYC_CENTER, 5); // 5km radius

    expect(supplies.length).toBeGreaterThan(0);

    const supply = supplies[0];
    expect(supply.providerId).toBe("citi-bike-nyc");
    expect(supply.mode).toBe("micromobility");
    expect(supply.availableCapacity).toBeGreaterThan(0);
    expect(supply.provenance.environment).toBe("OBSERVED_ONLY");
    expect(supply.provenance.source).toBe("citi-bike-nyc");
    expect(supply.provenance.confidence).toBeGreaterThan(0.9);
    expect(supply.provenance.observedAt).toBeTruthy();

    // Verify the supply is near NYC
    const distance = haversineKm(NYC_CENTER, supply.origin);
    expect(distance).toBeLessThanOrEqual(5);

    // Verify the data is not synthetic
    expect(supply.source).toBe("citybik-es");
    expect(supply.externalReference).toBeTruthy(); // station ID from the API
  });

  test("supplies have real station names", async () => {
    const provider = new CitiBikeNYCProvider();
    const supplies = await provider.discoverSupply(NYC_CENTER, 3);
    if (supplies.length > 0) {
      expect(supplies[0].origin.name).toBeTruthy();
      // Station names are real street intersections
      expect(supplies[0].origin.name).toMatch(/&|Ave|St|Street|Broadway|Park/i);
    }
  });

  test("stations with 0 bikes are excluded", async () => {
    const provider = new CitiBikeNYCProvider();
    const supplies = await provider.discoverSupply(NYC_CENTER, 10);
    for (const s of supplies) {
      expect(s.availableCapacity).toBeGreaterThan(0);
    }
  });

  // ─── PROVENANCE ISOLATION ─────────────────────────────────────────
  test("OBSERVED_ONLY supply cannot produce W3-M/W4-M evidence", () => {
    // Even if someone tried to create an execution from observed-only supply,
    // the evidence function rejects it.
    const fakeExecution: TransportationExecution = {
      id: "exec-fake",
      agreementId: "agr-fake",
      opportunityId: "opp-fake",
      demandId: "dem-fake",
      supplyId: "supply-fake",
      providerId: "citi-bike-nyc",
      state: "COMPLETED",
      environment: "OBSERVED_ONLY",
      evidenceEligible: false,
      provenance: {
        environment: "OBSERVED_ONLY",
        source: "citi-bike-nyc",
        observedAt: new Date().toISOString(),
        confidence: 0.95,
      },
      isMarketplaceOpportunity: true,
      researchStimulus: false,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const evidence = canProduceMarketplaceEvidence(fakeExecution);
    expect(evidence.w3m).toBe(false);
    expect(evidence.w4m).toBe(false);
    expect(evidence.reason).toContain("OBSERVED_ONLY");
  });

  test("OBSERVED_ONLY is distinct from SANDBOX and LIVE", () => {
    expect(MARKETPLACE_EVIDENCE_RULES.sandboxCannotProduce).toContain("W3-M");
    expect(MARKETPLACE_EVIDENCE_RULES.sandboxCannotProduce).toContain("W4-M");

    // The evidence function rejects any environment !== "LIVE"
    const observedOnlyExec: TransportationExecution = {
      id: "test",
      agreementId: "test",
      opportunityId: "test",
      demandId: "test",
      supplyId: "test",
      providerId: "citi-bike-nyc",
      state: "COMPLETED",
      environment: "OBSERVED_ONLY",
      evidenceEligible: false,
      provenance: {
        environment: "OBSERVED_ONLY",
        source: "citi-bike-nyc",
        observedAt: new Date().toISOString(),
        confidence: 1,
      },
      isMarketplaceOpportunity: true,
      researchStimulus: false,
      createdAt: new Date().toISOString(),
    };
    const result = canProduceMarketplaceEvidence(observedOnlyExec);
    expect(result.w3m).toBe(false);
    expect(result.w4m).toBe(false);
    // OBSERVED_ONLY is not LIVE, so it's excluded
    expect(result.reason).toContain("OBSERVED_ONLY");
  });

  // ─── INTEGRATION STATUS ───────────────────────────────────────────
  test("integration status starts as DISABLED", () => {
    const provider = new CitiBikeNYCProvider();
    expect(provider.getIntegrationStatus()).toBe("DISABLED");
  });

  test("health check transitions status to CONNECTED", async () => {
    const provider = new CitiBikeNYCProvider();
    expect(provider.getIntegrationStatus()).toBe("DISABLED");
    await provider.healthCheck();
    expect(provider.getIntegrationStatus()).toBe("CONNECTED");
  });
});

// Haversine distance (km)
function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
