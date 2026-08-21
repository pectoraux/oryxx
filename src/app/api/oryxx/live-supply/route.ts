// ORYXX — Live Supply Experiment API
//
// Runs the live supply experiment: baseline (ordinary routing) vs ORYXX
// (with live Citi Bike station availability). Results are MODELLED planning
// estimates, NOT marketplace transactions. Cannot produce W3-M/W4-M.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import {
  runLiveSupplyExperiment,
  runFreshnessSweep,
  loadSnapshot,
  type ExperimentConfig,
} from "@/lib/oryxx/live/experiment/live-supply-experiment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NYC_CENTER = { lat: 40.7589, lon: -73.9851 };
const SNAPSHOT_TIMESTAMP = "2026-08-21T15:53:30Z";

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
    const config: ExperimentConfig = {
      geography: { center: NYC_CENTER, radiusKm: 5, city: "New York, NY" },
      demandCount: parseInt(url.searchParams.get("demandCount") || "100"),
      demandSeed: parseInt(url.searchParams.get("seed") || "42"),
      freshnessWindowSec: parseInt(url.searchParams.get("freshness") || "300"),
      snapshotTimestamp: SNAPSHOT_TIMESTAMP,
      walkingSpeedKmh: 5,
      bikingSpeedKmh: 15,
      maxWalkingKm: 0.5,
      valuePerMinuteSaved: 50,
      valuePerKmSaved: 100,
    };

    const result = runLiveSupplyExperiment(config);
    return NextResponse.json(result);
  }

  if (view === "freshness_sweep") {
    const baseConfig: ExperimentConfig = {
      geography: { center: NYC_CENTER, radiusKm: 5, city: "New York, NY" },
      demandCount: 100,
      demandSeed: 42,
      freshnessWindowSec: 60,
      snapshotTimestamp: SNAPSHOT_TIMESTAMP,
      walkingSpeedKmh: 5,
      bikingSpeedKmh: 15,
      maxWalkingKm: 0.5,
      valuePerMinuteSaved: 50,
      valuePerKmSaved: 100,
    };

    const windows = [60, 300, 600, 1200, 1800];
    const results = runFreshnessSweep(baseConfig, windows);
    return NextResponse.json({
      sweep: results.map((r) => ({
        windowSec: r.windowSec,
        baselineOpportunities: r.result.baseline.opportunities,
        oryxxOpportunities: r.result.oryxx.opportunities,
        additionalOpportunities: r.result.oryxx.additionalOpportunities,
        travelTimeDeltaMin: r.result.oryxx.travelTimeDeltaMin,
        estimatedValueDelta: r.result.oryxx.estimatedValueDelta,
        stationsWithinWindow: r.result.freshness.stationsWithinWindow,
        expiryRate: r.result.freshness.expiryRate,
      })),
      provenance: results[0]?.result.provenance,
      note: "All values are MODELLED planning estimates, not realized marketplace transactions.",
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
    provenance: {
      environment: "OBSERVED_ONLY",
      executionCapable: false,
      acceptanceCapable: false,
      canProduceW3M: false,
      canProduceW4M: false,
    },
    endpoints: {
      snapshot: "/api/oryxx/live-supply?view=snapshot",
      experiment: "/api/oryxx/live-supply?view=experiment",
      freshnessSweep: "/api/oryxx/live-supply?view=freshness_sweep",
    },
  });
}
