// ORYXX — Live Supply Experiment Engine
//
// Compares ordinary routing (baseline) against ORYXX routing enhanced with
// live Citi Bike station availability observations.
//
// KEY DISTINCTIONS:
// - OBSERVED: station location, free_bikes count, timestamp
// - INFERRED: route feasibility, walking distance, arrival estimate
// - ASSUMED: user accepts walking, bike remains available until arrival
// - UNKNOWN: actual booking, acceptance, completion
//
// This experiment CANNOT produce W3-M/W4-M. It measures planning/opportunity
// discovery value from live external supply, not marketplace transactions.
//
// All economic values are MODELLED, not REALIZED.

import type { GeoPoint, Provenance, TransportationSupply, TransportationDemand } from "../types";
import type { LiveObservationSnapshot, SnapshotStation } from "./snapshot-types";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface ExperimentConfig {
  geography: {
    center: GeoPoint;
    radiusKm: number;
    city: string;
  };
  demandCount: number;
  demandSeed: number;
  freshnessWindowSec: number; // max age of observations
  snapshotTimestamp: string;
  walkingSpeedKmh: number;
  bikingSpeedKmh: number;
  maxWalkingKm: number;
  valuePerMinuteSaved: number; // cents
  valuePerKmSaved: number; // cents
}

export interface ExperimentResult {
  experimentId: string;
  runTimestamp: string;
  snapshotTimestamp: string;
  config: ExperimentConfig;
  stationCount: number;
  stationsWithBikes: number;
  totalBikesObserved: number;
  baseline: {
    opportunities: number;
    feasibleOpportunities: number;
    meanTravelTimeMin: number;
    meanWalkingKm: number;
    estimatedValue: number; // MODELLED, not REALIZED
  };
  oryxx: {
    opportunities: number;
    feasibleOpportunities: number;
    additionalOpportunities: number;
    meanTravelTimeMin: number;
    meanWalkingKm: number;
    estimatedValue: number; // MODELLED, not REALIZED
    estimatedValueDelta: number; // ORYXX - baseline
    travelTimeDeltaMin: number;
    walkingBurdenDeltaKm: number;
  };
  freshness: {
    windowSec: number;
    stationsWithinWindow: number;
    stationsExpired: number;
    expiryRate: number;
  };
  provenance: {
    environment: "OBSERVED_ONLY";
    source: string;
    snapshotType: "LIVE_OBSERVATION_SNAPSHOT";
    noFixtureSupply: boolean;
    noW3M: boolean;
    noW4M: boolean;
  };
  classifications: {
    observed: string[];
    inferred: string[];
    assumed: string[];
    unknown: string[];
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SNAPSHOT LOADER
// ═══════════════════════════════════════════════════════════════════════

import snapshotData from "./snapshots/citi-bike-nyc-2026-08-21.json";

export function loadSnapshot(): LiveObservationSnapshot {
  return snapshotData as LiveObservationSnapshot;
}

// ═══════════════════════════════════════════════════════════════════════
// GEOMETRY
// ═══════════════════════════════════════════════════════════════════════

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ═══════════════════════════════════════════════════════════════════════
// DEMAND GENERATION
// ═══════════════════════════════════════════════════════════════════════

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateDemands(config: ExperimentConfig): TransportationDemand[] {
  const rng = seededRandom(config.demandSeed);
  const demands: TransportationDemand[] = [];
  const nowSec = Math.floor(new Date(config.snapshotTimestamp).getTime() / 1000) % 86400;

  for (let i = 0; i < config.demandCount; i++) {
    // Generate origin/destination within radius of center
    const angle1 = rng() * 2 * Math.PI;
    const dist1 = rng() * config.geography.radiusKm;
    const angle2 = rng() * 2 * Math.PI;
    const dist2 = rng() * config.geography.radiusKm;

    const latPerKm = 1 / 111;
    const lonPerKm = 1 / (111 * Math.cos((config.geography.center.lat * Math.PI) / 180));

    demands.push({
      id: `demand-${i}`,
      source: "direct-user",
      requestType: "rideshare",
      kind: "person",
      origin: {
        lat: config.geography.center.lat + dist1 * Math.sin(angle1) * latPerKm,
        lon: config.geography.center.lon + dist1 * Math.cos(angle1) * lonPerKm,
        name: `Origin ${i}`,
      },
      destination: {
        lat: config.geography.center.lat + dist2 * Math.sin(angle2) * latPerKm,
        lon: config.geography.center.lon + dist2 * Math.cos(angle2) * lonPerKm,
        name: `Destination ${i}`,
      },
      timeWindow: { startSec: nowSec, endSec: nowSec + 3600 },
      latestArrivalSec: nowSec + 7200,
      partySize: 1,
      weightKg: 0,
      volumeM3: 0,
      budget: 2000, // $20 in cents (MODELLED)
      value: 3000, // $30 in cents (MODELLED)
      priority: "normal",
      constraints: { maxWalkingKm: config.maxWalkingKm },
      status: "OPEN",
      createdAt: new Date().toISOString(),
    });
  }

  return demands;
}

// ═══════════════════════════════════════════════════════════════════════
// BASELINE: Ordinary Routing (no live station availability)
// ═══════════════════════════════════════════════════════════════════════

function evaluateBaseline(
  demands: TransportationDemand[],
  config: ExperimentConfig,
): {
  opportunities: number;
  feasibleOpportunities: number;
  totalTravelTimeMin: number;
  totalWalkingKm: number;
  estimatedValue: number;
} {
  let opportunities = 0;
  let feasibleOpportunities = 0;
  let totalTravelTimeMin = 0;
  let totalWalkingKm = 0;
  let estimatedValue = 0;

  for (const demand of demands) {
    const directDistance = haversineKm(demand.origin, demand.destination);
    // Baseline: assume walking or transit only (no bike-share station availability knowledge)
    const walkingTime = (directDistance / config.walkingSpeedKmh) * 60;
    totalTravelTimeMin += walkingTime;
    opportunities++;

    // Baseline considers all trips "feasible" (can always walk)
    feasibleOpportunities++;

    // MODELLED value: baseline has no bike savings
    estimatedValue += 0;
  }

  return {
    opportunities,
    feasibleOpportunities,
    totalTravelTimeMin,
    totalWalkingKm: 0, // baseline = direct walking, no station walking
    estimatedValue,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ORYXX: With Live Station Availability
// ═══════════════════════════════════════════════════════════════════════

function evaluateOryxx(
  demands: TransportationDemand[],
  snapshot: LiveObservationSnapshot,
  config: ExperimentConfig,
): {
  opportunities: number;
  feasibleOpportunities: number;
  additionalOpportunities: number;
  totalTravelTimeMin: number;
  totalWalkingKm: number;
  estimatedValue: number;
  travelTimeDeltaMin: number;
  walkingBurdenDeltaKm: number;
  estimatedValueDelta: number;
} {
  let opportunities = 0;
  let feasibleOpportunities = 0;
  let totalTravelTimeMin = 0;
  let totalWalkingKm = 0;
  let estimatedValue = 0;

  const snapshotTime = new Date(config.snapshotTimestamp).getTime();

  for (const demand of demands) {
    const directDistance = haversineKm(demand.origin, demand.destination);

    // Baseline travel time (walking)
    const baselineTime = (directDistance / config.walkingSpeedKmh) * 60;

    // Find nearest station with bikes within freshness window
    let bestStation: SnapshotStation | null = null;
    let bestStationDist = Infinity;
    let bestStationWalkTime = 0;
    let bestBikeTime = 0;
    let bestDestWalkTime = 0;

    for (const station of snapshot.stations) {
      // Freshness check
      const stationTime = new Date(station.timestamp).getTime();
      const ageSec = (snapshotTime - stationTime) / 1000;
      if (ageSec > config.freshnessWindowSec) continue;

      // Must have bikes
      if (station.free_bikes <= 0) continue;

      const stationDist = haversineKm(demand.origin, {
        lat: station.latitude,
        lon: station.longitude,
      });

      // Must be within walking tolerance
      if (stationDist > config.maxWalkingKm) continue;

      // Calculate bike route time
      const walkToStation = (stationDist / config.walkingSpeedKmh) * 60;
      const stationToDest = haversineKm(
        { lat: station.latitude, lon: station.longitude },
        demand.destination,
      );
      const bikeTime = (stationToDest / config.bikingSpeedKmh) * 60;

      const totalTime = walkToStation + bikeTime;

      if (totalTime < baselineTime && totalTime < (bestBikeTime || Infinity)) {
        bestStation = station;
        bestStationDist = stationDist;
        bestStationWalkTime = walkToStation;
        bestBikeTime = bikeTime;
        bestDestWalkTime = 0; // assume direct dropoff
      }
    }

    if (bestStation) {
      // ORYXX found a bike-share opportunity
      opportunities++;
      feasibleOpportunities++;
      const oryxxTime = bestStationWalkTime + bestBikeTime;
      totalTravelTimeMin += oryxxTime;
      totalWalkingKm += bestStationDist;

      // MODELLED value: time saved vs baseline
      const timeSavedMin = baselineTime - oryxxTime;
      estimatedValue += Math.round(timeSavedMin * config.valuePerMinuteSaved);
    } else {
      // No bike opportunity found — fall back to walking
      opportunities++;
      feasibleOpportunities++;
      totalTravelTimeMin += baselineTime;
    }
  }

  // Compute deltas vs baseline
  const baselineResult = evaluateBaseline(demands, config);
  const baselineMeanTime = baselineResult.totalTravelTimeMin / demands.length;
  const oryxxMeanTime = totalTravelTimeMin / demands.length;
  const baselineValue = baselineResult.estimatedValue;

  return {
    opportunities,
    feasibleOpportunities,
    additionalOpportunities: feasibleOpportunities - baselineResult.feasibleOpportunities,
    totalTravelTimeMin,
    totalWalkingKm,
    estimatedValue,
    travelTimeDeltaMin: oryxxMeanTime - baselineMeanTime,
    walkingBurdenDeltaKm: totalWalkingKm / demands.length,
    estimatedValueDelta: estimatedValue - baselineValue,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FRESHNESS ANALYSIS
// ═══════════════════════════════════════════════════════════════════════

function analyzeFreshness(
  snapshot: LiveObservationSnapshot,
  config: ExperimentConfig,
): {
  windowSec: number;
  stationsWithinWindow: number;
  stationsExpired: number;
  expiryRate: number;
} {
  const snapshotTime = new Date(config.snapshotTimestamp).getTime();
  let within = 0;
  let expired = 0;

  for (const station of snapshot.stations) {
    const stationTime = new Date(station.timestamp).getTime();
    const ageSec = (snapshotTime - stationTime) / 1000;
    if (ageSec <= config.freshnessWindowSec) {
      within++;
    } else {
      expired++;
    }
  }

  return {
    windowSec: config.freshnessWindowSec,
    stationsWithinWindow: within,
    stationsExpired: expired,
    expiryRate: expired / snapshot.stations.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN EXPERIMENT RUNNER
// ═══════════════════════════════════════════════════════════════════════

export function runLiveSupplyExperiment(config: ExperimentConfig): ExperimentResult {
  const snapshot = loadSnapshot();
  const demands = generateDemands(config);

  const stationsWithBikes = snapshot.stations.filter((s) => s.free_bikes > 0).length;
  const totalBikes = snapshot.stations.reduce((sum, s) => sum + s.free_bikes, 0);

  const baselineResult = evaluateBaseline(demands, config);
  const oryxxResult = evaluateOryxx(demands, snapshot, config);
  const freshness = analyzeFreshness(snapshot, config);

  const n = demands.length || 1;

  return {
    experimentId: `live-exp-${Date.now()}-${config.demandSeed}`,
    runTimestamp: new Date().toISOString(),
    snapshotTimestamp: config.snapshotTimestamp,
    config,
    stationCount: snapshot.stations.length,
    stationsWithBikes,
    totalBikesObserved: totalBikes,
    baseline: {
      opportunities: baselineResult.opportunities,
      feasibleOpportunities: baselineResult.feasibleOpportunities,
      meanTravelTimeMin: Math.round((baselineResult.totalTravelTimeMin / n) * 100) / 100,
      meanWalkingKm: 0,
      estimatedValue: baselineResult.estimatedValue,
    },
    oryxx: {
      opportunities: oryxxResult.opportunities,
      feasibleOpportunities: oryxxResult.feasibleOpportunities,
      additionalOpportunities: oryxxResult.additionalOpportunities,
      meanTravelTimeMin: Math.round((oryxxResult.totalTravelTimeMin / n) * 100) / 100,
      meanWalkingKm: Math.round((oryxxResult.totalWalkingKm / n) * 100) / 100,
      estimatedValue: oryxxResult.estimatedValue,
      estimatedValueDelta: oryxxResult.estimatedValueDelta,
      travelTimeDeltaMin: Math.round(oryxxResult.travelTimeDeltaMin * 100) / 100,
      walkingBurdenDeltaKm: Math.round(oryxxResult.walkingBurdenDeltaKm * 100) / 100,
    },
    freshness,
    provenance: {
      environment: "OBSERVED_ONLY",
      source: "citybik.es API (Citi Bike NYC)",
      snapshotType: "LIVE_OBSERVATION_SNAPSHOT",
      noFixtureSupply: true,
      noW3M: true,
      noW4M: true,
    },
    classifications: {
      observed: ["station location", "free_bikes count", "timestamp"],
      inferred: ["route feasibility", "walking distance", "arrival estimate", "bike route time"],
      assumed: ["user accepts walking to station", "bike remains available until arrival", "user chooses bike-share"],
      unknown: ["actual booking", "actual acceptance", "actual completion"],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FRESHNESS SWEEP
// ═══════════════════════════════════════════════════════════════════════

export function runFreshnessSweep(
  baseConfig: ExperimentConfig,
  windows: number[],
): Array<{ windowSec: number; result: ExperimentResult }> {
  return windows.map((windowSec) => {
    const config = { ...baseConfig, freshnessWindowSec: windowSec };
    return { windowSec, result: runLiveSupplyExperiment(config) };
  });
}
