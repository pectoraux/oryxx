// ORYXX — Live Supply Information-Value Experiment API
//
// Runs the information-treatment experiment: baseline (without live
// inventory) vs ORYXX (with live inventory). Both strategies have
// identical routing modes. The ONLY difference is access to live
// Citi Bike station-availability observations.
//
// All results are MODELLED planning estimates, NOT marketplace transactions.
// Cannot produce W3-M/W4-M.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import {
  runLiveSupplyExperiment,
  runFreshnessSweep,
  runInvariantCheck,
  loadSnapshot,
  type ExperimentConfig,
} from "@/lib/oryxx/live/experiment/live-supply-experiment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NYC_CENTER = { lat: 40.7589, lon: -73.9851 };
const SNAPSHOT_TIMESTAMP = "2026-08-21T15:53:30Z";

function makeConfig(overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    geography: { center: NYC_CENTER, radiusKm: 5, city: "New York, NY" },
    demandCount: 100,
    demandSeed: 42,
    freshnessWindowSec: 300,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
    walkingSpeedKmh: 5,
    bikingSpeedKmh: 15,
    maxWalkingKm: 0.5,
    valuePerMinuteSaved: 50,
    baselineUncertaintyPenaltyMin: 10,
    ...overrides,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "overview";

  if (view === "snapshot") {
    const snapshot = loadSnapshot();
    return NextResponse.json({
      snapshotType: snapshot.snapshotType,
      source: snapshot.source,
      networkName: snapshot.networkName,
      capturedAt: snapshot.capturedAt,
      stationCount: snapshot.stationCount,
      stationsWithBikes: snapshot.stations.filter((s) => s.free_bikes > 0).length,
      totalBikes: snapshot.stations.reduce((sum, s) => sum + s.free_bikes, 0),
      environment: "OBSERVED_ONLY",
      note: "Live observation snapshot from CityBik.es API. This is NOT transactional. ORYXX cannot reserve or book these bikes.",
    });
  }

  if (view === "experiment") {
    const config = makeConfig({
      demandCount: parseInt(url.searchParams.get("demandCount") || "100"),
      demandSeed: parseInt(url.searchParams.get("seed") || "42"),
      freshnessWindowSec: parseInt(url.searchParams.get("freshness") || "300"),
      baselineUncertaintyPenaltyMin: parseFloat(url.searchParams.get("penalty") || "10"),
    });

    const result = runLiveSupplyExperiment(config);
    return NextResponse.json(result);
  }

  if (view === "freshness_sweep") {
    const windows = [60, 300, 600, 1200, 1800];
    const results = runFreshnessSweep(makeConfig(), windows);
    return NextResponse.json({
      sweep: results.map((r) => ({
        windowSec: r.windowSec,
        newlyDiscoverableCount: r.result.routeLevel.newlyDiscoverableCount,
        newlyDiscoverableRate: r.result.routeLevel.newlyDiscoverableRate,
        oryxxWins: r.result.routeLevel.oryxxWins,
        baselineWins: r.result.routeLevel.baselineWins,
        meanCostDelta: r.result.routeLevel.meanCostDelta,
        meanTimeDeltaMin: r.result.routeLevel.meanTimeDeltaMin,
        stationsWithinWindow: r.result.freshness.stationsWithinWindow,
        staleRate: r.result.freshness.expiryRate,
      })),
      provenance: results[0]?.result.provenance,
      note: "All values are MODELLED planning estimates, not realized marketplace transactions.",
    });
  }

  if (view === "invariant") {
    const result = runInvariantCheck(makeConfig({ demandCount: 50 }));
    return NextResponse.json({
      withLiveInventory: {
        newlyDiscoverableCount: result.withLiveInventory.routeLevel.newlyDiscoverableCount,
        oryxxWins: result.withLiveInventory.routeLevel.oryxxWins,
      },
      withZeroInventory: {
        newlyDiscoverableCount: result.withZeroInventory.routeLevel.newlyDiscoverableCount,
        oryxxWins: result.withZeroInventory.routeLevel.oryxxWins,
      },
      invariantHolds: result.invariantHolds,
      explanation: "If all free_bikes are set to 0, ORYXX should become equivalent to baseline (0 newly discoverable routes).",
    });
  }

  const snapshot = loadSnapshot();
  return NextResponse.json({
    snapshot: {
      type: snapshot.snapshotType,
      source: snapshot.source,
      capturedAt: snapshot.capturedAt,
      stationCount: snapshot.stationCount,
    },
    environment: "OBSERVED_ONLY",
    design: {
      title: "Information-Treatment Experiment",
      question: "Does access to live station-availability information create routing value beyond an equivalent router without that information?",
      baselineInfo: "Station locations + routing modes, but NO live inventory (UNKNOWN availability with uncertainty penalty)",
      oryxxInfo: "Station locations + routing modes + LIVE observed free_bikes within freshness window",
      difference: "Only live inventory differs. Same routes, same evaluator, same cost function.",
    },
    endpoints: {
      snapshot: "/api/oryxx/live-supply?view=snapshot",
      experiment: "/api/oryxx/live-supply?view=experiment",
      freshnessSweep: "/api/oryxx/live-supply?view=freshness_sweep",
      invariant: "/api/oryxx/live-supply?view=invariant",
    },
  });
}
