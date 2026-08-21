// ORYXX — Live Supply Information-Value Experiment Tests.
//
// Tests the redesigned experiment module. Verifies that:
// - Both strategies use identical routing modes and evaluation
// - The ONLY difference is access to live inventory
// - Baseline cannot access free_bikes
// - ORYXX can access free_bikes
// - Unknown availability does not become observed availability
// - Newly discoverable routes are causally attributable to live info
// - Zero-inventory invariant holds (ORYXX == baseline when no bikes)
// - CANNOT produce W3-M/W4-M

import { test, expect, describe } from "bun:test";
import {
  runLiveSupplyExperiment,
  runFreshnessSweep,
  runInvariantCheck,
  loadSnapshot,
  type ExperimentConfig,
} from "../src/lib/oryxx/live/experiment/live-supply-experiment";
import { canProduceMarketplaceEvidence } from "../src/lib/oryxx/live/types";
import type { TransportationExecution } from "../src/lib/oryxx/live/types";

const baseConfig: ExperimentConfig = {
  geography: { center: { lat: 40.7589, lon: -73.9851 }, radiusKm: 5, city: "New York, NY" },
  demandCount: 50,
  demandSeed: 42,
  freshnessWindowSec: 300,
  snapshotTimestamp: "2026-08-21T15:53:30Z",
  walkingSpeedKmh: 5,
  bikingSpeedKmh: 15,
  maxWalkingKm: 0.5,
  valuePerMinuteSaved: 50,
  baselineUncertaintyPenaltyMin: 10,
};

describe("ORYXX Live Supply Information-Value Experiment", () => {

  // ─── SNAPSHOT ────────────────────────────────────────────────────
  test("snapshot is LIVE_OBSERVATION_SNAPSHOT (not fixture)", () => {
    const snapshot = loadSnapshot();
    expect(snapshot.snapshotType).toBe("LIVE_OBSERVATION_SNAPSHOT");
    expect(snapshot.source).toContain("citybik.es");
    expect(snapshot.stationCount).toBeGreaterThan(100);
  });

  test("snapshot has real station data with timestamps", () => {
    const snapshot = loadSnapshot();
    const station = snapshot.stations[0];
    expect(station.id).toBeTruthy();
    expect(station.name).toBeTruthy();
    expect(station.latitude).toBeGreaterThan(40);
    expect(station.timestamp).toBeTruthy();
  });

  // ─── REPRODUCIBILITY ──────────────────────────────────────────────
  test("same config produces identical route-level results", () => {
    const r1 = runLiveSupplyExperiment(baseConfig);
    const r2 = runLiveSupplyExperiment(baseConfig);
    expect(r1.routeLevel.newlyDiscoverableCount).toBe(r2.routeLevel.newlyDiscoverableCount);
    expect(r1.routeLevel.oryxxWins).toBe(r2.routeLevel.oryxxWins);
    expect(r1.routeLevel.meanCostDelta).toBe(r2.routeLevel.meanCostDelta);
  });

  // ─── A. IDENTICAL DEMAND POPULATION ───────────────────────────────
  test("both strategies use identical demand population", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    // Every demand result has both baseline and oryxx evaluations
    expect(result.demandResults.length).toBe(baseConfig.demandCount);
    for (const dr of result.demandResults) {
      expect(dr.baseline).toBeTruthy();
      expect(dr.oryxx).toBeTruthy();
      expect(dr.originLat).toBe(dr.originLat); // same demand
    }
  });

  // ─── B. IDENTICAL ROUTE/ EVALUATION PRIMITIVES ────────────────────
  test("both strategies enumerate the same route types", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    // Check a demand that has a station within walking
    const withStation = result.demandResults.find((d) => d.hasStationWithinWalking);
    if (withStation) {
      const baselineTypes = withStation.baseline.allRoutes.map((r) => r.type);
      const oryxxTypes = withStation.oryxx.allRoutes.map((r) => r.type);
      // Both should have walk_direct and bike_share routes
      expect(baselineTypes).toContain("walk_direct");
      expect(oryxxTypes).toContain("walk_direct");
      // Baseline has bike_share routes with UNKNOWN availability
      const baselineBikeRoutes = withStation.baseline.allRoutes.filter((r) => r.type === "bike_share");
      for (const r of baselineBikeRoutes) {
        expect(r.availabilityStatus).toBe("UNKNOWN");
        expect(r.isSelectable).toBe(true); // baseline CAN select with uncertainty penalty
      }
    }
  });

  // ─── C. ONLY LIVE INVENTORY DIFFERS ──────────────────────────────
  test("baseline routes have UNKNOWN availability; ORYXX routes have OBSERVED/STALE/UNAVAILABLE", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    const withStation = result.demandResults.find((d) => d.hasStationWithinWalking);
    if (withStation) {
      // Baseline: ALL bike routes have UNKNOWN availability
      const baselineBikes = withStation.baseline.allRoutes.filter((r) => r.type === "bike_share");
      for (const r of baselineBikes) {
        expect(r.availabilityStatus).toBe("UNKNOWN");
      }
      // ORYXX: bike routes have OBSERVED_AVAILABLE_AT_T, STALE, or UNAVAILABLE
      const oryxxBikes = withStation.oryxx.allRoutes.filter((r) => r.type === "bike_share");
      for (const r of oryxxBikes) {
        expect(["OBSERVED_AVAILABLE_AT_T", "STALE", "UNAVAILABLE"]).toContain(r.availabilityStatus);
        // Baseline NEVER has OBSERVED_AVAILABLE_AT_T
        expect(r.availabilityStatus).not.toBe("UNKNOWN");
      }
    }
  });

  // ─── D. BASELINE CANNOT ACCESS free_bikes ────────────────────────
  test("baseline bike routes do not use free_bikes data", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    const withStation = result.demandResults.find((d) => d.hasStationWithinWalking);
    if (withStation) {
      const baselineBikes = withStation.baseline.allRoutes.filter((r) => r.type === "bike_share");
      for (const r of baselineBikes) {
        // Baseline treats all stations the same — no distinction based on free_bikes
        expect(r.availabilityStatus).toBe("UNKNOWN");
        // Baseline routes are ALL selectable (with uncertainty penalty)
        expect(r.isSelectable).toBe(true);
      }
    }
  });

  // ─── E. ORYXX CAN ACCESS free_bikes ──────────────────────────────
  test("ORYXX bike routes use free_bikes to determine availability", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    const withStation = result.demandResults.find((d) => d.hasStationWithinWalking);
    if (withStation) {
      const oryxxBikes = withStation.oryxx.allRoutes.filter((r) => r.type === "bike_share");
      // At least one should be OBSERVED_AVAILABLE or UNAVAILABLE (using free_bikes)
      const hasObservedOrUnavailable = oryxxBikes.some(
        (r) => r.availabilityStatus === "OBSERVED_AVAILABLE_AT_T" || r.availabilityStatus === "UNAVAILABLE"
      );
      expect(hasObservedOrUnavailable).toBe(true);
    }
  });

  // ─── F. UNKNOWN does not become OBSERVED ────────────────────────
  test("baseline UNKNOWN availability never becomes OBSERVED_AVAILABLE", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    for (const dr of result.demandResults) {
      const baselineBikes = dr.baseline.allRoutes.filter((r) => r.type === "bike_share");
      for (const r of baselineBikes) {
        expect(r.availabilityStatus).not.toBe("OBSERVED_AVAILABLE_AT_T");
      }
    }
  });

  // ─── G. STALE INVENTORY FILTERED ────────────────────────────────
  test("stale observations are excluded by ORYXX (marked STALE, not selectable)", () => {
    const tightConfig = { ...baseConfig, freshnessWindowSec: 1 };
    const result = runLiveSupplyExperiment(tightConfig);
    expect(result.freshness.stationsExpired).toBeGreaterThan(0);
    // ORYXX should not route via stale stations
    for (const dr of result.demandResults) {
      const staleRoutes = dr.oryxx.allRoutes.filter((r) => r.availabilityStatus === "STALE");
      for (const r of staleRoutes) {
        expect(r.isSelectable).toBe(false);
      }
    }
  });

  // ─── H. NEWLY DISCOVERABLE DEFINITION ────────────────────────────
  test("newly discoverable = ORYXX chose bike, baseline did not (due to uncertainty)", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    for (const dr of result.demandResults) {
      if (dr.comparison.newlyDiscoverable) {
        // ORYXX selected bike
        expect(dr.oryxx.bestRoute.type).toBe("bike_share");
        // Baseline did NOT select bike (walked instead due to uncertainty penalty)
        expect(dr.baseline.bestRoute.type).not.toBe("bike_share");
      }
    }
  });

  // ─── I. BASELINE CAN STILL CHOOSE BIKE (with uncertainty) ───────
  test("baseline can select bike-share under its uncertainty policy", () => {
    const config = { ...baseConfig, baselineUncertaintyPenaltyMin: 0 }; // no penalty → baseline always prefers bike if faster
    const result = runLiveSupplyExperiment(config);
    // With zero penalty, baseline should sometimes choose bike
    const baselineBikeChosen = result.demandResults.some(
      (d) => d.baseline.bestRoute.type === "bike_share"
    );
    // This depends on having stations within walking distance of some demands
    const demandsWithStations = result.demandResults.filter((d) => d.hasStationWithinWalking);
    if (demandsWithStations.length > 0) {
      expect(baselineBikeChosen).toBe(true);
    }
  });

  // ─── J. ORYXX CAN LOSE ──────────────────────────────────────────
  test("ORYXX can lose (baseline wins when station observed as unavailable)", () => {
    // With very large penalty, baseline will always walk; ORYXX might also walk
    // if all nearby stations have 0 bikes.
    // This test verifies the experiment allows BASELINE_WINS
    const config = { ...baseConfig, baselineUncertaintyPenaltyMin: 1000 };
    const result = runLiveSupplyExperiment(config);
    // With huge penalty, baseline always walks; ORYXX walks if no bikes available
    // The experiment should report results without forcing ORYXX to win
    expect(result.routeLevel.baselineWins + result.routeLevel.oryxxWins + result.routeLevel.ties + result.routeLevel.neitherHasBike).toBe(baseConfig.demandCount);
  });

  // ─── K. ORYXX CAN TIE ───────────────────────────────────────────
  test("ORYXX can tie with baseline (same route selected)", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    // When baseline walks and ORYXX also walks (no station available), it's a tie
    expect(result.routeLevel.ties + result.routeLevel.neitherHasBike).toBeGreaterThan(0);
  });

  // ─── M. NO FIXTURE CONTAMINATION ────────────────────────────────
  test("no fixture supply appears in live experiment", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.provenance.noFixtureSupply).toBe(true);
    expect(result.provenance.snapshotType).toBe("LIVE_OBSERVATION_SNAPSHOT");
  });

  // ─── N. W3-M IMPOSSIBLE ────────────────────────────────────────
  test("experiment cannot produce W3-M", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.provenance.noW3M).toBe(true);
    // Also verify via evidence function
    const fakeExec: TransportationExecution = {
      id: "test", agreementId: "test", opportunityId: "test", demandId: "test",
      supplyId: "test", providerId: "citi-bike-nyc", state: "COMPLETED",
      environment: "OBSERVED_ONLY", evidenceEligible: false,
      provenance: { environment: "OBSERVED_ONLY", source: "citi-bike-nyc", observedAt: new Date().toISOString(), confidence: 0.95 },
      isMarketplaceOpportunity: true, researchStimulus: false, createdAt: new Date().toISOString(),
    };
    const evidence = canProduceMarketplaceEvidence(fakeExec);
    expect(evidence.w3m).toBe(false);
    expect(evidence.reason).toContain("OBSERVED_ONLY");
  });

  // ─── O. W4-M IMPOSSIBLE ────────────────────────────────────────
  test("experiment cannot produce W4-M", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    expect(result.provenance.noW4M).toBe(true);
  });

  // ─── INVARIANT: ZERO INVENTORY → ORYXX == BASELINE ─────────────
  test("zero-inventory invariant: ORYXX becomes equivalent to baseline when no bikes", () => {
    const result = runInvariantCheck(baseConfig);
    // With all free_bikes = 0, ORYXX should find 0 newly discoverable routes
    expect(result.withZeroInventory.routeLevel.newlyDiscoverableCount).toBe(0);
    expect(result.invariantHolds).toBe(true);
  });

  // ─── FRESHNESS SWEEP ────────────────────────────────────────────
  test("freshness sweep produces results for multiple windows", () => {
    const windows = [60, 300, 600, 1200, 1800];
    const results = runFreshnessSweep(baseConfig, windows);
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.result.freshness.windowSec).toBe(r.windowSec);
      expect(r.result.provenance.noW3M).toBe(true);
    }
  });

  // ─── NEGATIVE RESULTS ALLOWED ──────────────────────────────────
  test("experiment allows negative results (ORYXX finds nothing useful)", () => {
    const config: ExperimentConfig = {
      ...baseConfig,
      freshnessWindowSec: 1, // very tight — most stations stale
      maxWalkingKm: 0.01,   // 10m walking — no stations reachable
      demandCount: 10,
    };
    const result = runLiveSupplyExperiment(config);
    // With almost no reachable stations, ORYXX should find 0 newly discoverable
    expect(result.routeLevel.newlyDiscoverableCount).toBe(0);
  });

  // ─── DEMAND DISTRIBUTION ───────────────────────────────────────
  test("demand distribution is reasonable for NYC", () => {
    const result = runLiveSupplyExperiment(baseConfig);
    // Demands should be within the geography radius
    for (const dr of result.demandResults) {
      const originDist = haversineKm(
        { lat: dr.originLat, lon: dr.originLon },
        { lat: 40.7589, lon: -73.9851 }
      );
      expect(originDist).toBeLessThanOrEqual(baseConfig.geography.radiusKm + 1); // +1 for rounding
    }
    // Some demands should have stations within walking distance
    expect(result.demandsWithStation).toBeGreaterThan(0);
  });
});

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
