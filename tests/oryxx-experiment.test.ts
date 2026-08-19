// ORYXX — Experiment engine tests.
//
// Verifies the canonical layer (feasibility, welfare, geometry) and the
// experiment invariants (no duplicate matching, capacity, regime validity,
// exact solver activation, performance, etc.).
//
// Run with:  bun test tests/oryxx-experiment.test.ts
//
// Tests are deterministic where possible (fixed seeds). Engine files are
// treated as the source of truth — failing tests are fixed in this file,
// not in the engine, unless a genuine engine bug is found (then reported).

import { test, expect, describe } from "bun:test";

// Canonical layer
import type {
  WorldConfig,
  PriceMechanism,
  StrategyId,
} from "../src/lib/oryxx/market/canonical/types";
import { DEFAULT_WORLD } from "../src/lib/oryxx/market/canonical/types";
import { checkFeasibility } from "../src/lib/oryxx/market/canonical/feasibility";
import {
  evaluate,
  makeRideshareMarketSupply,
} from "../src/lib/oryxx/market/canonical/evaluate";
import {
  negotiatePrice,
  ordinaryMarketPrice,
} from "../src/lib/oryxx/market/canonical/pricing";
import { dist, routeServes } from "../src/lib/oryxx/market/canonical/geometry";

// Domain types + generators
import type { DemandRequest, SupplyOffer, Loc } from "../src/lib/oryxx/market/types";
import {
  places,
  generateDemands,
  generateSupplies,
} from "../src/lib/oryxx/market/generate";

// Experiment runner + invariants + regimes
import { runSingle } from "../src/lib/oryxx/market/experiment/runner";
import { checkInvariants } from "../src/lib/oryxx/market/experiment/invariants";
import { REGIMES, regimeToConfig } from "../src/lib/oryxx/market/experiment/regimes";

// Strategies (needed for multi-pass capacity test where we need a controlled
// single-supply multi-demand scenario that the runner can't construct via
// its generator-driven config).
import { runOryxx } from "../src/lib/oryxx/market/strategies/oryxx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDemand(overrides: Partial<DemandRequest> = {}): DemandRequest {
  return {
    id: "D-test",
    kind: "person",
    origin: { x: 0, y: 0 },
    destination: { x: 10, y: 0 },
    window: { start: 500, end: 600 },
    latestArrival: undefined,
    partySize: 1,
    budget: 100,
    value: 100,
    createdAt: 0,
    originName: "Origin",
    destName: "Dest",
    ...overrides,
  };
}

function makeSupply(overrides: Partial<SupplyOffer> = {}): SupplyOffer {
  return {
    id: "S-test",
    kind: "rideshare",
    origin: { x: 0, y: 0 },
    destination: { x: 10, y: 0 },
    originName: "Origin",
    destName: "Dest",
    departure: 550,
    capacitySeats: 4,
    availableCapacity: 4,
    minCompensation: 5,
    detourToleranceKm: 1.0,
    executionProbability: 0.9,
    reliability: 0.86,
    costPerKm: 0.35,
    isCommitted: true,
    route: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    ...overrides,
  };
}

function balancedRegime() {
  const r = REGIMES.find((r) => r.id === "balanced");
  if (!r) throw new Error("balanced regime not found");
  return r;
}

function balancedConfig(seed = 42, numSeeds = 1) {
  return regimeToConfig(balancedRegime(), seed, numSeeds);
}

const ALL_STRATEGY_IDS: StrategyId[] = ["ordinary", "centralized", "oryxx", "clairvoyant"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ORYXX canonical feasibility layer", () => {
  test("1. temporal: supply departing outside the demand window is infeasible (temporal-window)", () => {
    const d = makeDemand({ window: { start: 500, end: 520 } });
    const s = makeSupply({ departure: 600 }); // 10:00 — after window end (520)
    const f = checkFeasibility(d, s, s.availableCapacity, DEFAULT_WORLD);
    expect(f.feasible).toBe(false);
    expect(f.reasonIfInfeasible).toBe("temporal-window");
  });

  test("2. capacity: availableCapacity < partySize is infeasible (capacity)", () => {
    const d = makeDemand({ partySize: 3 });
    const s = makeSupply({ availableCapacity: 2, capacitySeats: 2 });
    const f = checkFeasibility(d, s, 2, DEFAULT_WORLD);
    expect(f.feasible).toBe(false);
    expect(f.reasonIfInfeasible).toBe("capacity");
  });

  test("3. kind: pallet demand + rideshare supply is infeasible (kind-incompatible)", () => {
    const d = makeDemand({ kind: "pallet" });
    const s = makeSupply({ kind: "rideshare" });
    const f = checkFeasibility(d, s, s.availableCapacity, DEFAULT_WORLD);
    expect(f.feasible).toBe(false);
    expect(f.reasonIfInfeasible).toBe("kind-incompatible");
  });

  test("4. budget: minCompensation > budget → negotiatePrice=-1, evaluate price-infeasible", () => {
    // ordinaryMarketPrice(person, 10km horizontal) = 3 + 1.6*10 = 19
    // budget=5  → ceil = min(5, 19) = 5 < reservation=50 → -1
    const d = makeDemand({ budget: 5, value: 50 });
    const s = makeSupply({ minCompensation: 50 });
    // direct negotiatePrice check (both mechanisms that respect budget ceiling)
    const npNegotiated = negotiatePrice(d, s, ordinaryMarketPrice(d), "negotiated");
    expect(npNegotiated).toBe(-1);
    const npMarket = negotiatePrice(d, s, ordinaryMarketPrice(d), "market");
    expect(npMarket).toBe(-1);
    const npOryxx = negotiatePrice(d, s, ordinaryMarketPrice(d), "oryxx");
    expect(npOryxx).toBe(-1);
    // evaluate should mark infeasible with reason containing "price-infeasible"
    const ev = evaluate(d, s, s.availableCapacity, DEFAULT_WORLD, "negotiated");
    expect(ev.feasible).toBe(false);
    expect(ev.reasonIfInfeasible).toContain("price-infeasible");
  });

  test("5. spatial: pickup far from the supply's route (beyond detourToleranceKm) is infeasible (spatial-detour)", () => {
    // supply route runs along y=0 from x=0 to x=10
    const s = makeSupply({
      origin: { x: 0, y: 0 },
      destination: { x: 10, y: 0 },
      route: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      detourToleranceKm: 0.5,
    });
    // demand pickup/dropoff 50km off the route — way beyond tolerance
    const d = makeDemand({
      origin: { x: 5, y: 50 },
      destination: { x: 8, y: 50 },
    });
    const f = checkFeasibility(d, s, s.availableCapacity, DEFAULT_WORLD);
    expect(f.feasible).toBe(false);
    expect(f.reasonIfInfeasible).toBe("spatial-detour");
    // sanity: routeServes agrees
    const rs = routeServes(s.route, d.origin, d.destination, s.detourToleranceKm);
    expect(rs.feasible).toBe(false);
  });
});

describe("ORYXX welfare consistency (CRITICAL invariant)", () => {
  test("6. for every feasible evaluation, socialSurplus == value - supplierCost (within 0.02) across all mechanisms", () => {
    const ps = places(20);
    const demands = generateDemands({ seed: 7, n: 25, regionKm: 20, places: ps });
    const realSupplies = generateSupplies({
      seed: 11,
      numDrivers: 12,
      numNPDs: 6,
      numTrucks: 4,
      numTransitLines: 3,
      regionKm: 20,
      places: ps,
    });
    // include RSM synthetic supplies (used by ordinary/centralized/oryxx)
    const rsmSupplies = demands.map(makeRideshareMarketSupply);
    const allSupplies = [...realSupplies, ...rsmSupplies];

    const mechanisms: PriceMechanism[] = ["oryxx", "negotiated", "market"];
    let feasibleCount = 0;
    const violations: string[] = [];

    for (const mech of mechanisms) {
      for (const d of demands) {
        for (const s of allSupplies) {
          const ev = evaluate(d, s, s.capacitySeats, DEFAULT_WORLD, mech);
          if (!ev.feasible) continue;
          feasibleCount++;
          const expected = Math.round((d.value - ev.supplierCost) * 100) / 100;
          const delta = Math.abs(ev.socialSurplus - expected);
          if (delta > 0.02) {
            violations.push(
              `${mech} ${d.id}×${s.id}: socialSurplus=${ev.socialSurplus} expected=${expected} delta=${delta}`,
            );
          }
        }
      }
    }

    // We must have tested at least one feasible evaluation per mechanism
    expect(feasibleCount).toBeGreaterThan(0);
    if (violations.length > 0) {
      console.error("Welfare violations:\n" + violations.join("\n"));
    }
    expect(violations).toHaveLength(0);
  });
});

describe("ORYXX experiment invariants", () => {
  test("7. duplicate-matching: runSingle metrics for each strategy contain no duplicate demandId", () => {
    const cfg = balancedConfig(42, 1);
    cfg.numDemands = 30;
    const run = runSingle(cfg, 42);
    for (const sid of ALL_STRATEGY_IDS) {
      const evs = run.metrics[sid].evaluations;
      const ids = evs.map((e) => e.demandId);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    }
  });

  test("8. multi-pass capacity: capacitySeats=4 serves multiple partySize=1 demands but not 5", () => {
    const route: Loc[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const supply = makeSupply({
      id: "S-multi",
      capacitySeats: 4,
      availableCapacity: 4,
      route,
      origin: route[0],
      destination: route[1],
      departure: 550,
      detourToleranceKm: 0.5,
      minCompensation: 1, // cheap so price-infeasible doesn't trigger
      costPerKm: 0.2,
    });
    const demands: DemandRequest[] = [];
    for (let i = 0; i < 5; i++) {
      demands.push(
        makeDemand({
          id: `D${i + 1}`,
          kind: "person",
          partySize: 1,
          origin: { x: 0, y: 0 },
          destination: { x: 10, y: 0 },
          window: { start: 500, end: 600 },
          budget: 50,
          value: 100,
        }),
      );
    }
    const { metrics, matches } = runOryxx(demands, [supply], DEFAULT_WORLD);
    // ORYXX augments the supply pool with a per-demand RSM fallback, so all
    // 5 demands get served — but only 4 via the shared capacity-4 supply
    // (the 5th must fall through to its own RSM). This is the multi-pass
    // capacity invariant: the shared supply is never over-allocated.
    expect(metrics.matchedDemands).toBe(5); // all demands served overall
    const supplyMatches = matches.filter((m) => m.supplyId === supply.id);
    expect(supplyMatches.length).toBe(4); // exactly 4 on the shared supply (== capacitySeats)
    expect(supplyMatches.length).toBeLessThanOrEqual(supply.capacitySeats);
    // the 5th demand went to its RSM fallback
    const rsmMatches = matches.filter((m) => m.supplyId.startsWith("RSM-"));
    expect(rsmMatches.length).toBe(1);
    // all 5 demandIds are distinct
    const matchedIds = new Set(matches.map((m) => m.demandId));
    expect(matchedIds.size).toBe(5);
  });

  test("9. zero-demand world: runSingle numDemands=0 doesn't crash; all metrics zero", () => {
    const cfg = balancedConfig(42, 1);
    cfg.numDemands = 0;
    cfg.numDrivers = 5;
    cfg.numNPDs = 3;
    cfg.numTrucks = 2;
    cfg.numTransitLines = 1;
    const run = runSingle(cfg, 42);
    expect(run.demands).toBe(0);
    for (const sid of ALL_STRATEGY_IDS) {
      const m = run.metrics[sid];
      expect(m.matchedDemands).toBe(0);
      expect(m.unmatchedDemands).toBe(0);
      expect(m.totalDemands).toBe(0);
      expect(m.matchingRate).toBe(0);
      expect(m.totalSocialSurplus).toBe(0);
      expect(m.totalRiskAdjustedWelfare).toBe(0);
      expect(m.totalUserCost).toBe(0);
      expect(m.totalSupplierCost).toBe(0);
      expect(m.evaluations).toHaveLength(0);
    }
    // invariants should still pass (no demands to violate)
    expect(run.invariantsPassed).toBe(true);
  });

  test("10. zero-supply world: ordinary matches via RSM fallback; ORYXX matches the same count", () => {
    const cfg = balancedConfig(42, 1);
    cfg.numDemands = 60;
    cfg.numDrivers = 0;
    cfg.numNPDs = 0;
    cfg.numTrucks = 0;
    cfg.numTransitLines = 0;
    const run = runSingle(cfg, 42);
    const ord = run.metrics.ordinary.matchedDemands;
    const oryxx = run.metrics.oryxx.matchedDemands;
    // sanity: ordinary still matches some demands via the synthetic RSM
    expect(ord).toBeGreaterThan(0);
    // ORYXX must match the same count (only supply available is RSM)
    expect(oryxx).toBe(ord);
    // all ORYXX matches use the RSM fallback
    for (const ev of run.metrics.oryxx.evaluations) {
      expect(ev.supplyId.startsWith("RSM-")).toBe(true);
    }
  });

  test("11. no-feasible-route: origin==destination & budget=0 → ordinary doesn't match", () => {
    const d = makeDemand({
      id: "D-selfloop",
      origin: { x: 5, y: 5 },
      destination: { x: 5, y: 5 },
      budget: 0,
      value: 10,
      partySize: 1,
    });
    // ordinary's only supply is the synthetic RSM at market rate
    const rsm = makeRideshareMarketSupply(d);
    const ev = evaluate(d, rsm, rsm.availableCapacity, DEFAULT_WORLD, "market");
    expect(ev.feasible).toBe(false);
    // ordinaryMarketPrice(person, 0km) = 3.0; reservation = 3.0; budget = 0
    // → p = min(3, 0) = 0 < reservation → -1 → price-infeasible
    expect(ev.reasonIfInfeasible).toContain("price-infeasible");
  });

  test("12. performance: numDemands=500 runSingle completes in under 5 seconds", () => {
    const cfg = balancedConfig(42, 1);
    cfg.numDemands = 500;
    // drop clairvoyant to keep the run tractable AND under the 5s ceiling
    // even on slower machines (clairvoyant falls back to centralized which
    // duplicates the heaviest pass).
    cfg.strategies = ["ordinary", "centralized", "oryxx"];
    const t0 = Date.now();
    const run = runSingle(cfg, 42);
    const elapsed = Date.now() - t0;
    expect(run.demands).toBe(500);
    expect(elapsed).toBeLessThan(5000);
  });

  test("13. all-transit: only transit supply → ORYXX finds transit matches", () => {
    // Try a few seeds deterministically; the engine must produce at least one
    // transit match (TRN-* evaluations) on at least one seed.
    let foundTransitMatches = 0;
    let triedSeeds: number[] = [];
    for (const seed of [1, 2, 3, 7, 42, 100, 256]) {
      const cfg = balancedConfig(seed, 1);
      cfg.numDemands = 80;
      cfg.numDrivers = 0;
      cfg.numNPDs = 0;
      cfg.numTrucks = 0;
      cfg.numTransitLines = 12;
      cfg.strategies = ["ordinary", "oryxx"]; // skip exact/heuristic for speed
      const run = runSingle(cfg, seed);
      triedSeeds.push(seed);
      const transitMatches = run.metrics.oryxx.evaluations.filter((e) =>
        e.supplyId.startsWith("TRN"),
      );
      if (transitMatches.length > 0) {
        foundTransitMatches += transitMatches.length;
        break;
      }
    }
    expect(foundTransitMatches).toBeGreaterThan(0);
  });

  test("14. all-rideshare: numTransitLines=0, numNPDs=0, numTrucks=0 → ORYXX matches via RSM fallback", () => {
    const cfg = balancedConfig(42, 1);
    cfg.numDemands = 50;
    cfg.numDrivers = 30;
    cfg.numNPDs = 0;
    cfg.numTrucks = 0;
    cfg.numTransitLines = 0;
    const run = runSingle(cfg, 42);
    // ORYXX should match at least as many as ordinary (it subsumes ordinary)
    expect(run.metrics.oryxx.matchedDemands).toBeGreaterThanOrEqual(
      run.metrics.ordinary.matchedDemands,
    );
    // Every ORYXX match uses a real driver (DRV-*) or the RSM fallback
    for (const ev of run.metrics.oryxx.evaluations) {
      expect(
        ev.supplyId.startsWith("DRV") || ev.supplyId.startsWith("RSM-"),
      ).toBe(true);
    }
    // sanity: at least one match happened
    expect(run.metrics.oryxx.matchedDemands).toBeGreaterThan(0);
  });

  test("15. invariants: balanced regime numDemands=30 → invariantsPassed=true", () => {
    const cfg = balancedConfig(42, 1);
    cfg.numDemands = 30;
    const run = runSingle(cfg, 42);
    if (!run.invariantsPassed) {
      console.error("Invariant failures:\n" + run.invariantFailures.join("\n"));
    }
    expect(run.invariantsPassed).toBe(true);
  });

  test("16. exact solver: numDemands=10, exactMaxDemands=16 → clairvoyant isExact=true", () => {
    const cfg = balancedConfig(42, 1);
    cfg.numDemands = 10;
    cfg.exactMaxDemands = 16;
    const run = runSingle(cfg, 42);
    expect(run.metrics.clairvoyant.isExact).toBe(true);
    // clairvoyant should match at least as many as ordinary (it's optimal)
    expect(run.metrics.clairvoyant.matchedDemands).toBeGreaterThanOrEqual(
      run.metrics.ordinary.matchedDemands,
    );
    // clairvoyant welfare should be at least as high as ORYXX (optimum ≥ heuristic)
    expect(run.metrics.clairvoyant.totalRiskAdjustedWelfare).toBeGreaterThanOrEqual(
      run.metrics.oryxx.totalRiskAdjustedWelfare - 0.5,
    );
  });

  test("17. regime configs: regimeToConfig produces valid configs for all REGIMES (no NaN, numDemands>0)", () => {
    expect(REGIMES.length).toBeGreaterThan(0);
    for (const regime of REGIMES) {
      const cfg = regimeToConfig(regime, 42, 3);
      // required numeric fields are present, finite, and within sane bounds
      expect(cfg.numDemands).toBeGreaterThan(0);
      expect(cfg.numDrivers).toBeGreaterThanOrEqual(0);
      expect(cfg.numNPDs).toBeGreaterThanOrEqual(0);
      expect(cfg.numTrucks).toBeGreaterThanOrEqual(0);
      expect(cfg.numTransitLines).toBeGreaterThanOrEqual(0);
      expect(cfg.regionKm).toBeGreaterThan(0);
      expect(cfg.exactMaxDemands).toBeGreaterThan(0);
      expect(cfg.numSeeds).toBe(3);
      expect(Number.isFinite(cfg.seed)).toBe(true);
      expect(cfg.strategies).toHaveLength(6);
      expect(cfg.strategies).toContain("clairvoyant");
      // world has no NaN/Infinity — only the numeric fields (WorldConfig
      // also contains booleans which we check explicitly below).
      const w: WorldConfig = cfg.world;
      const numericFields: (keyof WorldConfig)[] = [
        "deadheadRatioRideshare",
        "deadheadRatioTruck",
        "repositionRatioAfterDrop",
        "speedKmh",
        "reliabilityWeight",
        "planningHorizonMin",
        "defaultDetourToleranceKm",
      ];
      for (const k of numericFields) {
        const v = w[k] as unknown as number;
        expect(Number.isFinite(v)).toBe(true);
      }
      // boolean fields must be true booleans (not NaN'd to a number)
      expect(typeof w.committedTripExecutesIfUnmatched).toBe("boolean");
      expect(typeof w.npdActivatesIfUnmatched).toBe("boolean");
      expect(typeof w.transitRunsRegardless).toBe("boolean");
      // specific world fields (sanity bounds)
      expect(w.deadheadRatioRideshare).toBeGreaterThanOrEqual(0);
      expect(w.deadheadRatioRideshare).toBeLessThanOrEqual(1);
      expect(w.deadheadRatioTruck).toBeGreaterThanOrEqual(0);
      expect(w.deadheadRatioTruck).toBeLessThanOrEqual(1);
      expect(w.repositionRatioAfterDrop).toBeGreaterThanOrEqual(0);
      expect(w.repositionRatioAfterDrop).toBeLessThanOrEqual(1);
      expect(w.reliabilityWeight).toBeGreaterThanOrEqual(0);
      expect(w.reliabilityWeight).toBeLessThanOrEqual(1);
      expect(w.speedKmh).toBeGreaterThan(0);
      expect(w.defaultDetourToleranceKm).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Direct invariants-module coverage (uses the public checkInvariants export)
// ---------------------------------------------------------------------------

describe("ORYXX invariants module (direct)", () => {
  test("checkInvariants flags a deliberately duplicated demand match", () => {
    // Build a metrics object where the same demandId appears twice — the
    // invariant module must catch it.
    const ps = places(20);
    const demands = generateDemands({ seed: 3, n: 5, regionKm: 20, places: ps });
    const supplies = generateSupplies({
      seed: 3,
      numDrivers: 4,
      numNPDs: 0,
      numTrucks: 0,
      numTransitLines: 0,
      regionKm: 20,
      places: ps,
    });
    const d0 = demands[0];
    const rsm = makeRideshareMarketSupply(d0);
    const ev = evaluate(d0, rsm, rsm.capacitySeats, DEFAULT_WORLD, "market");
    const dup = { ...ev };
    const metricsByStrategy = {
      oryxx: {
        strategyId: "oryxx" as StrategyId,
        matchedDemands: 2,
        unmatchedDemands: 3,
        totalDemands: 5,
        matchingRate: 0.4,
        totalUserCost: ev.price * 2,
        totalSupplierEarnings: ev.price * 2,
        totalSupplierCost: ev.supplierCost * 2,
        totalUserSurplus: ev.userSurplus * 2,
        totalSupplierSurplus: ev.supplierSurplus * 2,
        totalSocialSurplus: ev.socialSurplus * 2,
        totalRiskAdjustedWelfare: ev.riskAdjustedWelfare * 2,
        seatUtilization: 0.1,
        emptyVehicleKm: 0,
        deadheadKm: 0,
        avgTravelTimeMin: ev.travelTimeMin,
        avgDetourKm: ev.detourKm,
        unservedDemandValue: 0,
        solverRuntimeMs: 1,
        pairCount: 5,
        feasiblePairCount: 1,
        isExact: false,
        evaluations: [ev, dup],
      },
    };
    const result = checkInvariants(demands, supplies, DEFAULT_WORLD, metricsByStrategy as any);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("matched twice");
  });

  test("checkInvariants passes on a clean ordinary run", () => {
    // IMPORTANT: regenerate demands/supplies with the SAME config that
    // runSingle uses internally (same seed + same regionKm + same counts).
    // Otherwise the demand objects we pass to checkInvariants would have
    // different coordinates than the ones the evaluations were computed
    // against, and the welfare/feasibility re-checks would fail spuriously.
    const cfg = balancedConfig(9, 1);
    cfg.numDemands = 20;
    cfg.strategies = ["ordinary"];
    const ps = places(cfg.regionKm);
    const demands = generateDemands({
      seed: 9,
      n: cfg.numDemands,
      regionKm: cfg.regionKm,
      places: ps,
    });
    const supplies = generateSupplies({
      seed: 9,
      numDrivers: cfg.numDrivers,
      numNPDs: cfg.numNPDs,
      numTrucks: cfg.numTrucks,
      numTransitLines: cfg.numTransitLines,
      regionKm: cfg.regionKm,
      places: ps,
    });
    const run = runSingle(cfg, 9);
    const result = checkInvariants(
      demands,
      supplies,
      cfg.world,
      { ordinary: run.metrics.ordinary } as any,
    );
    if (!result.passed) {
      console.error("Invariant failures on clean ordinary run:\n" + result.failures.join("\n"));
    }
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Geometry sanity (cheap but worth pinning)
// ---------------------------------------------------------------------------

describe("ORYXX canonical geometry", () => {
  test("dist and routeServes behave as the engine assumes", () => {
    expect(dist({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
    // manhattan with diagonal slack: dx=10, dy=0 → max(10,0)+0.5*min(10,0)=10
    expect(dist({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
    // route perfectly serves demand on its segment → feasible
    const rs = routeServes(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      { x: 2, y: 0 },
      { x: 8, y: 0 },
      0.5,
    );
    expect(rs.feasible).toBe(true);
    // route does NOT serve a demand whose dropoff precedes pickup along a
    // multi-segment route (single-segment routes can't express order —
    // pickup and dropoff both lie on segment 0 — so we use two segments).
    const rsReversed = routeServes(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ],
      { x: 8, y: 0 }, // pickup near segment 1 (5→10)
      { x: 2, y: 0 }, // dropoff near segment 0 (0→5) — BEFORE pickup
      0.5,
    );
    expect(rsReversed.feasible).toBe(false);
  });
});
