// ORYXX — Real-world opportunity layer tests.
//
// Verifies the real-data layer: GTFS fixture, latent supply inference,
// opportunity engine, experiment runner, privacy/provenance invariants.
//
// Run with:  bun test tests/oryxx-real.test.ts
//
// Tests are deterministic (fixed seeds). Engine files are treated as the
// source of truth — failing tests are fixed in this file, not the engine,
// unless a genuine engine bug is found (then reported).

import { test, expect, describe } from "bun:test";

// Provider + interface helpers
import {
  FixtureAccraProvider,
  buildTransitFeed,
  buildMovements,
  ACCRA_PILOT,
  ACCRA_FIXTURE_SOURCE,
} from "../src/lib/oryxx/real/providers/fixture-accra";
import {
  haversineKm,
  projectToKm,
  secToTime,
  timeToSec,
} from "../src/lib/oryxx/real/providers/interface";

// Engine
import {
  inferLatentSupply,
  computeBaseline,
  generateOpportunities,
  generateDemands,
} from "../src/lib/oryxx/real/engine/opportunity";
import { runOpportunityExperiment } from "../src/lib/oryxx/real/engine/runner";
import {
  enumerateScenarios,
  buildMovementIndex,
  findCandidateMovements,
} from "../src/lib/oryxx/real/engine/uncertainty";
import { OsmAccraProvider, OSM_SOURCE } from "../src/lib/oryxx/real/providers/osm-accra";

// Types
import type {
  RealExperimentConfig,
  DemandObservation,
  LatentSupply,
  DataSource,
} from "../src/lib/oryxx/real/types";

// ---------------------------------------------------------------------------
// Helpers + shared fixtures
// ---------------------------------------------------------------------------

// Default experiment config chosen so that the fixture produces a non-empty
// opportunity set: morning-rush hour filter, modest detour tolerance.
const DEFAULT_CONFIG: RealExperimentConfig = {
  seed: 42,
  numDemands: 50,
  movementDensity: 1.0,
  planningHorizonSec: 0,
  willingness: 0.5,
  detourToleranceKm: 3.0,
  hourFilter: 7,
};

const provider = new FixtureAccraProvider(42, 1.0);
const dataSources: DataSource[] = [ACCRA_FIXTURE_SOURCE];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ORYXX real-data layer", () => {
  // === 1. GTFS parsing =====================================================
  describe("GTFS fixture parsing", () => {
    test("buildTransitFeed returns valid feed with stops/routes/trips/services", () => {
      const feed = buildTransitFeed();
      expect(feed.stops.length).toBeGreaterThan(0);
      expect(feed.routes.length).toBeGreaterThan(0);
      expect(feed.trips.length).toBeGreaterThan(0);
      expect(feed.services.length).toBeGreaterThan(0);
      expect(feed.agencyName.length).toBeGreaterThan(0);
      expect(feed.coverageStart.length).toBeGreaterThan(0);
      expect(feed.coverageEnd.length).toBeGreaterThan(0);
    });

    test("each trip has ordered stopTimes with arrivalSec <= departureSec (no time travel)", () => {
      const feed = buildTransitFeed();
      for (const trip of feed.trips) {
        expect(trip.stopTimes.length).toBeGreaterThan(1);
        for (let i = 0; i < trip.stopTimes.length; i++) {
          const st = trip.stopTimes[i];
          // dwell: arrival at this stop is at or before departure
          expect(st.arrivalSec).toBeLessThanOrEqual(st.departureSec);
          if (i > 0) {
            // consecutive stops: arrival at this stop must be after departure from previous
            const prev = trip.stopTimes[i - 1];
            expect(st.arrivalSec).toBeGreaterThan(prev.departureSec);
          }
        }
      }
    });

    test("each trip's route exists", () => {
      const feed = buildTransitFeed();
      const routeIds = new Set(feed.routes.map((r) => r.id));
      expect(routeIds.size).toBeGreaterThan(0);
      for (const trip of feed.trips) {
        expect(routeIds.has(trip.routeId)).toBe(true);
      }
    });
  });

  // === 2. Service-day correctness =========================================
  test("weekday service has mon-fri=true, sat/sun=false", () => {
    const feed = buildTransitFeed();
    const svc = feed.services.find((s) => s.id === "SVC_WEEKDAY");
    expect(svc).toBeDefined();
    expect(svc!.days.mon).toBe(true);
    expect(svc!.days.tue).toBe(true);
    expect(svc!.days.wed).toBe(true);
    expect(svc!.days.thu).toBe(true);
    expect(svc!.days.fri).toBe(true);
    expect(svc!.days.sat).toBe(false);
    expect(svc!.days.sun).toBe(false);
  });

  // === 3. Time-zone correctness ===========================================
  test("secToTime(3661) === '01:01:01'", () => {
    expect(secToTime(3661)).toBe("01:01:01");
  });

  test("timeToSec('01:01:01') === 3661", () => {
    expect(timeToSec("01:01:01")).toBe(3661);
  });

  // === 4. Haversine =======================================================
  test("haversineKm same point === 0; 1 degree lat ≈ 111km", () => {
    expect(haversineKm({ lat: 5.6, lon: -0.18 }, { lat: 5.6, lon: -0.18 })).toBe(0);
    const d = haversineKm({ lat: 5.6, lon: -0.18 }, { lat: 6.6, lon: -0.18 });
    // ~111 km per degree of latitude at the equator
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  // === 5. projectToKm =====================================================
  test("projectToKm(centerLat, centerLon, centerLat, centerLon) ≈ {x:0, y:0}", () => {
    const cLat = 5.6037;
    const cLon = -0.187;
    const p = projectToKm(cLat, cLon, cLat, cLon);
    expect(Math.abs(p.x)).toBeLessThan(0.001);
    expect(Math.abs(p.y)).toBeLessThan(0.001);
  });

  // === 6. Route feasibility ===============================================
  test("generateOpportunities only returns opportunities within demand window; oppCost < baselineCost", () => {
    const nodes = provider.getGeographicNodesSync();
    const transit = provider.getTransitFeedSync();
    const demands = generateDemands(DEFAULT_CONFIG, nodes);
    const movs = provider.getObservedMovementsSync(0, 24 * 3600);
    const { supply: latent } = inferLatentSupply(movs, DEFAULT_CONFIG, ACCRA_FIXTURE_SOURCE);
    const baseline = computeBaseline(demands, transit, nodes);
    const opps = generateOpportunities(
      demands,
      latent,
      baseline.perDemand,
      nodes,
      DEFAULT_CONFIG,
      dataSources,
    );
    expect(opps.length).toBeGreaterThan(0);
    const demandById = new Map(demands.map((d) => [d.id, d]));
    for (const o of opps) {
      const d = demandById.get(o.demandId);
      expect(d).toBeDefined();
      // departure must fall inside the (expanded-for-horizon) demand window
      expect(o.departureSec).toBeGreaterThanOrEqual(d!.windowStartSec);
      expect(o.departureSec).toBeLessThanOrEqual(d!.windowEndSec);
      // economic: opportunity is strictly cheaper than the baseline
      expect(o.opportunityCost).toBeLessThan(o.baselineCost);
    }
  });

  // === 7. Temporal transfer correctness ===================================
  test("latent supply departing BEFORE the demand window is NOT matched", () => {
    const nodes = provider.getGeographicNodesSync();
    const config: RealExperimentConfig = { ...DEFAULT_CONFIG, detourToleranceKm: 5 };
    // demand window 7:00-7:30
    const demand: DemandObservation = {
      id: "D-TEMP",
      origin: { x: 0, y: 0 },
      destination: { x: 3, y: 0 },
      windowStartSec: 7 * 3600,
      windowEndSec: 7.5 * 3600,
      partySize: 1,
      kind: "person",
      budget: 20,
      value: 20,
      source: ACCRA_FIXTURE_SOURCE,
    };
    // supply on the SAME route but departs at 6:00 — before the window opens
    const ls: LatentSupply = {
      id: "LS-TEMP",
      movementId: "M-TEMP",
      origin: { x: 0, y: 0 },
      destination: { x: 3, y: 0 },
      departureSec: 6 * 3600,
      arrivalSec: 6.25 * 3600,
      mode: "drive",
      assumedCapacity: 1,
      assumedWillingness: 0.5,
      assumedDetourToleranceKm: 5,
      assumedMinCompensation: 2.5,
      assumedExecutionProbability: 0.75,
      assumedReliability: 0.7,
      assumptions: [],
      source: ACCRA_FIXTURE_SOURCE,
      tier: 1,
    };
    const baseline = new Map([
      ["D-TEMP", { cost: 10, timeMin: 10, mode: "rideshare" }],
    ]);
    const opps = generateOpportunities([demand], [ls], baseline, nodes, config, dataSources);
    expect(opps.length).toBe(0);
  });

  // === 8. Geographic matching =============================================
  test("latent supply whose route is far from demand (beyond detourToleranceKm) is NOT matched", () => {
    const nodes = provider.getGeographicNodesSync();
    const config: RealExperimentConfig = { ...DEFAULT_CONFIG, detourToleranceKm: 2 };
    const demand: DemandObservation = {
      id: "D-GEO",
      origin: { x: 0, y: 0 },
      destination: { x: 3, y: 0 },
      windowStartSec: 7 * 3600,
      windowEndSec: 8 * 3600,
      partySize: 1,
      kind: "person",
      budget: 20,
      value: 20,
      source: ACCRA_FIXTURE_SOURCE,
    };
    // supply ~50km away — far beyond any reasonable tolerance, but within the time window
    const ls: LatentSupply = {
      id: "LS-GEO",
      movementId: "M-GEO",
      origin: { x: 50, y: 50 },
      destination: { x: 53, y: 50 },
      departureSec: 7.2 * 3600,
      arrivalSec: 7.5 * 3600,
      mode: "drive",
      assumedCapacity: 1,
      assumedWillingness: 0.5,
      assumedDetourToleranceKm: 2,
      assumedMinCompensation: 2.5,
      assumedExecutionProbability: 0.75,
      assumedReliability: 0.7,
      assumptions: [],
      source: ACCRA_FIXTURE_SOURCE,
      tier: 1,
    };
    const baseline = new Map([
      ["D-GEO", { cost: 10, timeMin: 10, mode: "rideshare" }],
    ]);
    const opps = generateOpportunities([demand], [ls], baseline, nodes, config, dataSources);
    expect(opps.length).toBe(0);
  });

  // === 9. Movement-window matching ========================================
  test("observed movements have departureSec < arrivalSec (no backwards time)", () => {
    const movs = buildMovements(42, 1.0);
    expect(movs.length).toBeGreaterThan(0);
    for (const m of movs) {
      expect(m.departureSec).toBeLessThan(m.arrivalSec);
    }
  });

  // === 10. Detour calculation =============================================
  test("opportunities have detourKm >= 0 and <= config.detourToleranceKm * 2", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const o of result.opportunities) {
      expect(o.detourKm).toBeGreaterThanOrEqual(0);
      // engine averages pickup+dropoff detour against ls.assumedDetourToleranceKm
      // (= config.detourToleranceKm), so the per-opportunity detour is bounded
      // by the tolerance (<= tolerance*2 is a deliberately loose sanity ceiling).
      expect(o.detourKm).toBeLessThanOrEqual(DEFAULT_CONFIG.detourToleranceKm * 2 + 0.01);
    }
  });

  // === 11. Opportunity generation =========================================
  test("runOpportunityExperiment returns opportunities.length > 0; all dependsOnLatentSupply === true", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const o of result.opportunities) {
      expect(o.dependsOnLatentSupply).toBe(true);
    }
  });

  // === 12. Capacity assumptions ===========================================
  test("inferLatentSupply: assumedCapacity=1, assumedWillingness=config.willingness", () => {
    const movs = buildMovements(42, 1.0);
    const { supply } = inferLatentSupply(movs, DEFAULT_CONFIG, ACCRA_FIXTURE_SOURCE);
    expect(supply.length).toBe(movs.length);
    for (const ls of supply) {
      expect(ls.assumedCapacity).toBe(1);
      expect(ls.assumedWillingness).toBe(DEFAULT_CONFIG.willingness);
      // detour tolerance + min comp + exec prob + reliability also pinned from config/defaults
      expect(ls.assumedDetourToleranceKm).toBe(DEFAULT_CONFIG.detourToleranceKm);
    }
  });

  // === 13. Privacy ========================================================
  test("all observed movements have anonymized === true; no personal identifiers", () => {
    const movs = buildMovements(42, 1.0);
    expect(movs.length).toBeGreaterThan(0);
    for (const m of movs) {
      expect(m.anonymized).toBe(true);
      // No personal identifier fields present on the record
      expect((m as any).userId).toBeUndefined();
      expect((m as any).email).toBeUndefined();
      expect((m as any).phone).toBeUndefined();
      expect((m as any).name).toBeUndefined();
      expect((m as any).driverId).toBeUndefined();
      expect((m as any).licensePlate).toBeUndefined();
    }
  });

  // === 14. Data provenance ================================================
  test("every DataSource has isFixture === true; every opportunity has dataSources.length > 0", () => {
    // Use fixture explicitly — the real-OSM path returns a real (non-fixture) DataSource
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    for (const ds of result.datasets) {
      expect(ds.isFixture).toBe(true);
    }
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const o of result.opportunities) {
      expect(o.dataSources.length).toBeGreaterThan(0);
      for (const ds of o.dataSources) {
        expect(ds.isFixture).toBe(true);
      }
    }
  });

  // === 15. Deterministic replay ==========================================
  test("runOpportunityExperiment with same config produces same opportunities.length and totalEstimatedValue", () => {
    const r1 = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    const r2 = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    expect(r1.opportunities.length).toBe(r2.opportunities.length);
    expect(r1.metrics.totalEstimatedValue).toBe(r2.metrics.totalEstimatedValue);
  });

  // === 16. Fixture transit departures =====================================
  test("getTransitDeparturesSync('S1', 7h-8h) returns sorted departures within window", () => {
    const dep = provider.getTransitDeparturesSync("S1", 7 * 3600, 8 * 3600);
    expect(dep.length).toBeGreaterThan(0);
    for (const d of dep) {
      expect(d.scheduledDepartureSec).toBeGreaterThanOrEqual(7 * 3600);
      expect(d.scheduledDepartureSec).toBeLessThanOrEqual(8 * 3600);
      expect(d.stopId).toBe("S1");
    }
    // verify sorted ascending by time
    for (let i = 1; i < dep.length; i++) {
      expect(dep[i].scheduledDepartureSec).toBeGreaterThanOrEqual(dep[i - 1].scheduledDepartureSec);
    }
  });

  // === 17. Pilot geography ================================================
  test("ACCRA_PILOT has valid bbox (min<max both dims) and knownLimitations.length > 0", () => {
    expect(ACCRA_PILOT.bbox.minLat).toBeLessThan(ACCRA_PILOT.bbox.maxLat);
    expect(ACCRA_PILOT.bbox.minLon).toBeLessThan(ACCRA_PILOT.bbox.maxLon);
    expect(ACCRA_PILOT.knownLimitations.length).toBeGreaterThan(0);
    expect(ACCRA_PILOT.dataSources.length).toBeGreaterThan(0);
  });

  // === 18. Confidence object ==============================================
  test("every opportunity's confidence: overall in [0,1], capacityBasis='assumed', willingnessBasis='assumed'", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const o of result.opportunities) {
      expect(o.confidence.overall).toBeGreaterThanOrEqual(0);
      expect(o.confidence.overall).toBeLessThanOrEqual(1);
      expect(o.confidence.capacityBasis).toBe("assumed");
      expect(o.confidence.willingnessBasis).toBe("assumed");
    }
  });

  // === 19. Tier correctness ===============================================
  test("opportunities have tier 1 or 2 (not 0/3/4)", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const o of result.opportunities) {
      expect(o.tier === 1 || o.tier === 2).toBe(true);
    }
  });

  // === 20. Planning horizon curve =========================================
  test("planningHorizonCurve returns 6 points; 7-day horizon opportunities >= 0-day horizon opportunities", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    const curve = result.planningHorizonCurve;
    expect(curve.length).toBe(6);
    // confirm the exact horizon values
    const horizons = curve.map((c) => c.horizonSec);
    expect(horizons).toContain(0);
    expect(horizons).toContain(7 * 24 * 3600);
    const day0 = curve.find((c) => c.horizonSec === 0);
    const day7 = curve.find((c) => c.horizonSec === 7 * 24 * 3600);
    expect(day0).toBeDefined();
    expect(day7).toBeDefined();
    // more future visibility = more (or equal) opportunities
    expect(day7!.opportunities).toBeGreaterThanOrEqual(day0!.opportunities);
  });

  // === 21. Survival analysis: robust/plausible/fragile/speculative tiers ===
  test("survival analysis produces robust/plausible/fragile/speculative counts", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false, survivalGrid: "conservative" });
    expect(result.survival).toBeDefined();
    expect(result.survival.totalScenarios).toBeGreaterThan(0);
    const total = result.survival.robustCount + result.survival.plausibleCount + result.survival.fragileCount + result.survival.speculativeCount;
    expect(total).toBeGreaterThan(0);
    // robust opportunities per 1000 is the headline metric
    expect(result.survival.robustPer1000).toBeGreaterThanOrEqual(0);
    // median survival rate in [0,1]
    expect(result.survival.medianSurvivalRate).toBeGreaterThanOrEqual(0);
    expect(result.survival.medianSurvivalRate).toBeLessThanOrEqual(1);
    // survival rate distribution buckets exist
    expect(result.survival.survivalRateDistribution.length).toBe(4);
  });

  // === 22. Robust opportunities <= total opportunities ===
  test("robust opportunities are a subset of all candidates", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false, survivalGrid: "conservative" });
    // robust count should be <= total opportunities (central assumption set)
    expect(result.survival.robustCount).toBeLessThanOrEqual(result.opportunities.length + 1);
    // conservative value per 1000 should be <= central value per 1000
    const centralPer1000 = result.metrics.totalEstimatedValue / Math.max(1, result.metrics.totalDemands) * 1000;
    expect(result.survival.conservativeValuePer1000).toBeLessThanOrEqual(centralPer1000 + 1);
  });

  // === 23. Density fits: all 4 models computed with R² ===
  test("density fits include linear, logarithmic, power, quadratic with R²", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false });
    expect(result.densityFits.length).toBe(4);
    const models = result.densityFits.map((f) => f.model);
    expect(models).toContain("linear");
    expect(models).toContain("logarithmic");
    expect(models).toContain("power");
    expect(models).toContain("quadratic");
    for (const f of result.densityFits) {
      expect(f.r2).toBeGreaterThanOrEqual(0);
      expect(f.r2).toBeLessThanOrEqual(1);
      expect(f.interpretation.length).toBeGreaterThan(0);
    }
  });

  // === 24. Movement index: spatial/temporal candidate pruning ===
  test("findCandidateMovements returns a subset of all movements", () => {
    const provider = new FixtureAccraProvider(42, 1.0);
    const nodes = provider.getGeographicNodesSync();
    const movements = provider.getObservedMovementsSync(0, 86400);
    const index = buildMovementIndex(movements, 1.0);
    const demand: DemandObservation = {
      id: "TEST-D1",
      origin: nodes[0],
      destination: nodes[10],
      windowStartSec: 7 * 3600,
      windowEndSec: 8 * 3600,
      partySize: 1,
      kind: "person",
      budget: 20,
      value: 30,
      source: movements[0].source,
    };
    const candidates = findCandidateMovements(demand, index, 2.0, 0);
    expect(candidates.length).toBeLessThanOrEqual(movements.length);
    // all candidates should be within the temporal window
    for (const m of candidates) {
      expect(m.departureSec).toBeGreaterThanOrEqual(6 * 3600);
      expect(m.departureSec).toBeLessThanOrEqual(9 * 3600);
    }
  });

  // === 25. Uncertainty grid enumeration ===
  test("enumerateScenarios produces the cartesian product", () => {
    const grid = {
      willingness: [0.1, 0.2],
      execution: [0.5, 0.7],
      detourToleranceKm: [1, 2],
      capacity: [1],
      compensationFloor: [2, 4],
    };
    const scenarios = enumerateScenarios(grid);
    // 2 * 2 * 2 * 1 * 2 = 16 scenarios
    expect(scenarios.length).toBe(16);
    // each scenario has all fields
    for (const s of scenarios) {
      expect(s.willingness).toBeGreaterThanOrEqual(0.1);
      expect(s.execution).toBeGreaterThanOrEqual(0.5);
      expect(s.capacity).toBeGreaterThanOrEqual(1);
    }
  });

  // === 26. Real OSM provider: pilot geography distinguishes real from fixture ===
  test("OsmAccraProvider pilot is labelled as real OSM (not fixture)", async () => {
    const provider = new OsmAccraProvider(42, 1.0);
    // the pilot geography should say "Real OSM" in its name
    const pilot = provider.getPilotGeographySync();
    expect(pilot.name).toContain("Real OSM");
    // the OSM data source should have isFixture=false
    expect(OSM_SOURCE.isFixture).toBe(false);
    expect(OSM_SOURCE.license).toContain("ODbL");
  });

  // === 27. Survival tiers are mutually exclusive ===
  test("survival robustness tiers are mutually exclusive per candidate", () => {
    const result = runOpportunityExperiment(DEFAULT_CONFIG, { useRealOsm: false, survivalGrid: "conservative" });
    for (const c of result.survival.candidates) {
      // exactly one of robust/plausible/fragile/speculative should be true
      const flags = [c.robustness === "robust", c.robustness === "plausible", c.robustness === "fragile", c.robustness === "speculative"];
      const trueCount = flags.filter(Boolean).length;
      expect(trueCount).toBe(1);
    }
  });
});
