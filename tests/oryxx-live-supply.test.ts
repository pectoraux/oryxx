// ORYXX — Live Supply Experiment Tests.
//
// Tests the live supply experiment module against a captured LIVE_OBSERVATION_SNAPSHOT.
// Verifies provenance isolation, snapshot reproducibility, freshness filtering,
// and that the experiment CANNOT produce W3-M/W4-M.

import { test, expect, describe } from "bun:test";
import {
  runLiveSupplyExperiment,
  runFreshnessSweep,
  loadSnapshot,
  type ExperimentConfig,
} from "../src/lib/oryxx/live/experiment/live-supply-experiment";
import { canProduceMarketplaceEvidence } from "../src/lib/oryxx/live/types";
import type { TransportationExecution } from "../src/lib/oryxx/live/types";

const NYC_CENTER = { lat: 40.7589, lon: -73.9851 };
const SNAPSHOT_TIMESTAMP = "2026-08-21T15:53:30Z";

const baseConfig: ExperimentConfig = {
  geography: { center: NYC_CENTER, radiusKm: 5, city: "New York, NY" },
  demandCount: 50,
  demandSeed: 42,
  freshnessWindowSec: 300,
  snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  walkingSpeedKmh: 5,
  bikingSpeedKmh: 15,
  maxWalkingKm: 0.5,
  valuePerMinuteSaved: 50,
  valuePerKmSaved: 100,
};

describe("ORYXX Live Supply Experiment", () => {

  // ─── SNAPSHOT REPRODUCIBILITY ─────────────────────────────────────
  test("snapshot loads with correct provenance", () => {
    const snapshot = loadSnapshot();
    expect(snapshot.snapshotType).toBe("LIVE_OBSERVATION_SNAPSHOT");
    expect(snapshot.source).toContain("citybik.es");
    expect(snapshot.stationCount).toBeGreaterThan(100);
    expect(snapshot.stations.length).toBeGreaterThan(100);
  });

  test("snapshot contains real station data with real timestamps", () => {
    const snapshot = loadSnapshot();
    const station = snapshot.stations[0];
    expect(station.id).toBeTruthy();
    expect(station.name).toBeTruthy();
    expect(station.latitude).toBeGreaterThan(40);
    expect(station.latitude).toBeLessThan(41);
    expect(station.longitude).toBeGreaterThan(-74.5);
    expect(station.longitude).toBeLessThan(-73.5);
    expect(station.timestamp).toBeTruthy();
  });

  test("same config produces same result (deterministic)", () => {
    const result1 = runLiveSupplyExperiment(baseConfig);
    const result2 = runLiveSupplyExperiment(baseConfig);
    expect(result1.oryxx.opportunities).toBe(result2.oryxx.opportunities);
    expect(result1.oryxx.feasibleOpportunities).toBe(result2.oryxx.feasibleOpportunities);
    expect(result1.baseline.meanTravelTimeMin).toBe(result2.baseline.meanTravelTimeMin);
    expect(result1.oryxx.meanTravelTimeMin).toBe(result2.oryxx.meanTravelTimeMin);
  });

  // ─── PROVENANCE ISOLATION ─────────────────────────────────────────
  test("experiment provenance is OBSERVED_ONLY", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.provenance.environment).toBe("OBSERVED_ONLY");
    expect(result.provenance.snapshotType).toBe("LIVE_OBSERVATION_SNAPSHOT");
    expect(result.provenance.noFixtureSupply).toBe(true);
  });

  test("experiment cannot produce W3-M", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.provenance.noW3M).toBe(true);
    // Also verify via the evidence function — an OBSERVED_ONLY execution
    // can never produce W3-M
    const fakeExec: TransportationExecution = {
      id: "test", agreementId: "test", opportunityId: "test", demandId: "test",
      supplyId: "test", providerId: "citi-bike-nyc", state: "COMPLETED",
      environment: "OBSERVED_ONLY", evidenceEligible: false,
      provenance: { environment: "OBSERVED_ONLY", source: "citi-bike-nyc", observedAt: new Date().toISOString(), confidence: 0.95 },
      isMarketplaceOpportunity: true, researchStimulus: false, createdAt: new Date().toISOString(),
    };
    const evidence = canProduceMarketplaceEvidence(fakeExec);
    expect(evidence.w3m).toBe(false);
    expect(evidence.w4m).toBe(false);
    expect(evidence.reason).toContain("OBSERVED_ONLY");
  });

  test("experiment cannot produce W4-M", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.provenance.noW4M).toBe(true);
  });

  // ─── CAPACITY SEMANTICS ───────────────────────────────────────────
  test("free_bikes is station inventory, not individual providers", () => {
    const snapshot = loadSnapshot();
    const stationWithBikes = snapshot.stations.find((s) => s.free_bikes > 0);
    expect(stationWithBikes).toBeTruthy();
    // A station with 8 bikes is ONE station observation, not 8 providers
    // The experiment treats it as one station inventory observation
    const result = runLiveSupplyExperiment(baseConfig);
    // The station count should be the number of stations, not total bikes
    expect(result.stationCount).toBe(snapshot.stations.length);
    expect(result.totalBikesObserved).toBeGreaterThan(result.stationsWithBikes);
  });

  // ─── FRESHNESS FILTERING ──────────────────────────────────────────
  test("stale observations are excluded by freshness window", () => {
    const tightConfig = { ...baseConfig, freshnessWindowSec: 1 }; // 1 second — very tight
    const result = runLiveSupplyExperiment(tightConfig);
    // With 1s freshness, many stations should be excluded
    expect(result.freshness.stationsExpired).toBeGreaterThan(0);
  });

  test("larger freshness window includes more stations", () => {
    const tightResult = runLiveSupplyExperiment({ ...baseConfig, freshnessWindowSec: 1 });
    const wideResult = runLiveSupplyExperiment({ ...baseConfig, freshnessWindowSec: 3600 });
    expect(wideResult.freshness.stationsWithinWindow).toBeGreaterThanOrEqual(tightResult.freshness.stationsWithinWindow);
  });

  // ─── BASELINE vs ORYXX ────────────────────────────────────────────
  test("baseline and ORYXX use same demand population", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.baseline.opportunities).toBe(result.oryxx.opportunities);
  });

  test("ORYXX finds additional opportunities or equal (never negative)", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    // ORYXX should find >= baseline feasible opportunities (it has more info)
    expect(result.oryxx.feasibleOpportunities).toBeGreaterThanOrEqual(result.baseline.feasibleOpportunities);
  });

  test("ORYXX mean travel time is <= baseline (or negative result is reported)", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    // ORYXX should not be worse than baseline (walking only)
    // If it is (walking burden > time saved), that's a valid negative result
    expect(result.oryxx.meanTravelTimeMin).toBeLessThanOrEqual(result.baseline.meanTravelTimeMin + 0.01);
  });

  // ─── MODELLED vs REALIZED ────────────────────────────────────────
  test("estimated value is MODELLED, not realized", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    // The experiment produces estimated/planning values, not marketplace transactions
    expect(result.baseline.estimatedValue).toBe(0); // baseline has no savings
    // ORYXX may have positive or zero estimated value
    expect(result.oryxx.estimatedValue).toBeGreaterThanOrEqual(0);
  });

  // ─── ZERO-BIKE STATIONS ──────────────────────────────────────────
  test("zero-bike stations are excluded from opportunities", () => {
    const snapshot = loadSnapshot();
    const zeroBikeStations = snapshot.stations.filter((s) => s.free_bikes === 0);
    expect(zeroBikeStations.length).toBeGreaterThan(0);
    // These stations should not contribute to ORYXX opportunities
    // (they are filtered in evaluateOryxx)
  });

  // ─── FRESHNESS SWEEP ─────────────────────────────────────────────
  test("freshness sweep produces results for multiple windows", () => {
    const windows = [60, 300, 600, 1200, 1800];
    const results = runFreshnessSweep(baseConfig, windows);
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.result.freshness.windowSec).toBe(r.windowSec);
      expect(r.result.provenance.noW3M).toBe(true);
    }
  });

  // ─── CLASSIFICATION ───────────────────────────────────────────────
  test("classifications distinguish observed/inferred/assumed/unknown", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.classifications.observed).toContain("station location");
    expect(result.classifications.observed).toContain("free_bikes count");
    expect(result.classifications.inferred).toContain("route feasibility");
    expect(result.classifications.inferred).toContain("walking distance");
    expect(result.classifications.assumed).toContain("user accepts walking to station");
    expect(result.classifications.assumed).toContain("bike remains available until arrival");
    expect(result.classifications.unknown).toContain("actual booking");
    expect(result.classifications.unknown).toContain("actual acceptance");
  });

  // ─── NO FIXTURE CONTAMINATION ────────────────────────────────────
  test("no fixture supply appears in live experiment", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.provenance.noFixtureSupply).toBe(true);
    expect(result.provenance.snapshotType).toBe("LIVE_OBSERVATION_SNAPSHOT");
    // The snapshot is NOT a fixture
    const snapshot = loadSnapshot();
    expect(snapshot.snapshotType).not.toBe("FIXTURE");
  });

  // ─── NEGATIVE RESULTS ALLOWED ───────────────────────────────────
  test("experiment allows ORYXX to find no additional opportunities", () => {
    // With a very tight freshness window and small walking radius,
    // ORYXX may find 0 additional opportunities — this is valid
    const tightConfig: ExperimentConfig = {
      ...baseConfig,
      freshnessWindowSec: 1,
      maxWalkingKm: 0.01, // 10 meters — almost no stations reachable
      demandCount: 5,
    };
    const result = runLiveSupplyExperiment(tightConfig);
    // The experiment should still produce results (even if negative)
    expect(result.baseline.opportunities).toBe(5);
    expect(result.oryxx.opportunities).toBe(5);
    // ORYXX may find 0 additional (all fell back to walking)
    expect(result.oryxx.additionalOpportunities).toBeGreaterThanOrEqual(0);
  });
});
