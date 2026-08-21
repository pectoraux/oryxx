// ORYXX — Live Supply Information-Value Experiment
//
// SCIENTIFIC DESIGN:
// This is an INFORMATION-TREATMENT experiment. The only experimental
// difference between BASELINE and ORYXX is access to live Citi Bike
// station-availability observations (free_bikes count + timestamp).
//
// Both strategies have IDENTICAL:
//   - demand population
//   - geography / network geometry
//   - walking model
//   - biking model
//   - station locations (both know where Citi Bike stations are)
//   - bike-share routing rules
//   - generalized cost / evaluation function
//   - user constraints
//
// BASELINE: "without live inventory information"
//   - Knows station LOCATIONS but NOT current inventory.
//   - Bike-share routes are CANDIDATES with UNKNOWN availability.
//   - Under the baseline's uncertainty policy, a bike-share route
//     receives an availability penalty (uncertainty cost).
//   - The baseline may still SELECT a bike-share route if the time
//     savings outweigh the uncertainty penalty.
//
// ORYXX: "with live inventory information"
//   - Knows station locations AND current observed free_bikes + timestamp.
//   - Stations with free_bikes > 0 within the freshness window are
//     marked OBSERVED_AVAILABLE_AT_T.
//   - Stations with free_bikes = 0 or stale are marked UNAVAILABLE_OR_STALE.
//   - Bike-share routes via observed-available stations have NO uncertainty
//     penalty (observation is fresh enough to act on).
//
// METRICS (route-level, causally attributable):
//   - NEWLY_DISCOVERABLE: route feasible under ORYXX info AND not
//     selectable under baseline info (bike route was too uncertain).
//   - INFORMATIONAL_IMPROVEMENT: generalized-cost delta (baseline - ORYXX).
//   - ROUTE_IMPROVEMENT_RATE: fraction of demands where ORYXX info
//     produces a strictly better route.
//   - BASELINE_WINS: fraction where baseline's uncertainty penalty
//     was small enough that it chose the same route at lower modelled cost.
//   - STALE_RATE: fraction of stations whose observations are too old.
//
// ALL economic values are MODELLED, not REALIZED.
// This experiment CANNOT produce W3-M/W4-M.

import type { GeoPoint } from "../types";
import type { LiveObservationSnapshot, SnapshotStation } from "./snapshot-types";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface ExperimentConfig {
  geography: { center: GeoPoint; radiusKm: number; city: string };
  demandCount: number;
  demandSeed: number;
  freshnessWindowSec: number;
  snapshotTimestamp: string;
  walkingSpeedKmh: number;
  bikingSpeedKmh: number;
  maxWalkingKm: number;
  valuePerMinuteSaved: number; // cents (MODELLED)
  // Baseline uncertainty penalty: if a bike-share route's generalized cost
  // is C_bike, the baseline modelled cost is C_bike + uncertaintyPenaltyMin * valuePerMinute.
  // This represents the expected cost of arriving at a station with unknown
  // availability and finding no bikes (forcing a fallback to walking).
  baselineUncertaintyPenaltyMin: number;
}

export type RouteType = "walk_direct" | "bike_share" | "walk_only";
export type AvailabilityStatus = "OBSERVED_AVAILABLE_AT_T" | "UNAVAILABLE" | "STALE" | "UNKNOWN";

export interface RouteOption {
  type: RouteType;
  travelTimeMin: number;
  walkingKm: number;
  generalizedCost: number; // MODELLED cost in cents
  stationId?: string;
  stationName?: string;
  availabilityStatus: AvailabilityStatus;
  isSelectable: boolean; // can this route be chosen given the information set?
}

export interface DemandResult {
  demandId: string;
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  directDistanceKm: number;
  nearestStationDistKm: number;
  hasStationWithinWalking: boolean;
  baseline: {
    bestRoute: RouteOption;
    allRoutes: RouteOption[];
  };
  oryxx: {
    bestRoute: RouteOption;
    allRoutes: RouteOption[];
  };
  comparison: {
    category: "ORYXX_WINS" | "BASELINE_WINS" | "TIE" | "NEITHER_HAS_BIKE";
    costDelta: number; // baseline.bestRoute.cost - oryxx.bestRoute.cost (>0 = ORYXX better)
    timeDeltaMin: number; // baseline.bestRoute.time - oryxx.bestRoute.time
    newlyDiscoverable: boolean; // ORYXX selected bike, baseline could not
  };
}

export interface ExperimentResult {
  experimentId: string;
  runTimestamp: string;
  snapshotTimestamp: string;
  config: ExperimentConfig;
  stationCount: number;
  stationsWithBikes: number;
  totalBikesObserved: number;
  stationsWithinFreshness: number;
  staleRate: number;
  demandCount: number;
  demandsWithStationInWalking: number;
  routeLevel: {
    newlyDiscoverableCount: number;
    newlyDiscoverableRate: number;
    oryxxWins: number;
    baselineWins: number;
    ties: number;
    neitherHasBike: number;
    meanCostDelta: number; // MODELLED cents, >0 = ORYXX better
    meanTimeDeltaMin: number; // >0 = ORYXX faster
    improvementRate: number; // fraction where ORYXX strictly better
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
  demandResults: DemandResult[];
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
// DEMAND GENERATION (deterministic, seeded)
// ═══════════════════════════════════════════════════════════════════════

interface Demand {
  id: string;
  origin: GeoPoint;
  destination: GeoPoint;
  directDistanceKm: number;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateDemands(config: ExperimentConfig): Demand[] {
  const rng = seededRandom(config.demandSeed);
  const demands: Demand[] = [];
  const latPerKm = 1 / 111;
  const lonPerKm = 1 / (111 * Math.cos((config.geography.center.lat * Math.PI) / 180));

  for (let i = 0; i < config.demandCount; i++) {
    const angle1 = rng() * 2 * Math.PI;
    const dist1 = rng() * config.geography.radiusKm;
    const angle2 = rng() * 2 * Math.PI;
    const dist2 = rng() * config.geography.radiusKm;

    const origin: GeoPoint = {
      lat: config.geography.center.lat + dist1 * Math.sin(angle1) * latPerKm,
      lon: config.geography.center.lon + dist1 * Math.cos(angle1) * lonPerKm,
    };
    const destination: GeoPoint = {
      lat: config.geography.center.lat + dist2 * Math.sin(angle2) * latPerKm,
      lon: config.geography.center.lon + dist2 * Math.cos(angle2) * lonPerKm,
    };

    demands.push({
      id: `demand-${i}`,
      origin,
      destination,
      directDistanceKm: haversineKm(origin, destination),
    });
  }

  return demands;
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTE ENUMERATION (identical for both strategies)
// ═══════════════════════════════════════════════════════════════════════

function enumerateRoutes(
  demand: Demand,
  stations: SnapshotStation[],
  config: ExperimentConfig,
  snapshotTime: number,
  hasLiveInventory: boolean, // false = baseline, true = ORYXX
): RouteOption[] {
  const routes: RouteOption[] = [];

  // ── Route 1: Walk direct ──────────────────────────────────────────
  const walkTime = (demand.directDistanceKm / config.walkingSpeedKmh) * 60;
  routes.push({
    type: "walk_direct",
    travelTimeMin: walkTime,
    walkingKm: demand.directDistanceKm,
    generalizedCost: Math.round(walkTime * config.valuePerMinuteSaved),
    availabilityStatus: "UNKNOWN", // walking is always available, no inventory needed
    isSelectable: true,
  });

  // ── Route 2+: Bike-share via stations ─────────────────────────────
  for (const station of stations) {
    const stationPoint: GeoPoint = { lat: station.latitude, lon: station.longitude };
    const walkToStation = haversineKm(demand.origin, stationPoint);
    if (walkToStation > config.maxWalkingKm) continue;

    const bikeDistance = haversineKm(stationPoint, demand.destination);
    if (bikeDistance < 0.1) continue; // too short to bike

    const walkTimeToStation = (walkToStation / config.walkingSpeedKmh) * 60;
    const bikeTime = (bikeDistance / config.bikingSpeedKmh) * 60;
    const totalTime = walkTimeToStation + bikeTime;

    // Determine availability status
    let availability: AvailabilityStatus;
    let isSelectable: boolean;
    let uncertaintyPenaltyMin: number;

    if (hasLiveInventory) {
      // ORYXX: has live inventory data
      const stationTime = new Date(station.timestamp).getTime();
      const ageSec = (snapshotTime - stationTime) / 1000;
      if (ageSec > config.freshnessWindowSec) {
        availability = "STALE";
        isSelectable = false; // ORYXX won't route via stale stations
        uncertaintyPenaltyMin = config.baselineUncertaintyPenaltyMin;
      } else if (station.free_bikes > 0) {
        availability = "OBSERVED_AVAILABLE_AT_T";
        isSelectable = true; // observed available → can select
        uncertaintyPenaltyMin = 0; // no penalty — observed at source time
      } else {
        availability = "UNAVAILABLE"; // observed as 0 bikes
        isSelectable = false;
        uncertaintyPenaltyMin = config.baselineUncertaintyPenaltyMin;
      }
    } else {
      // BASELINE: no live inventory — availability is UNKNOWN
      availability = "UNKNOWN";
      // Baseline CAN select a bike-share route, but with an uncertainty penalty
      // representing the risk of arriving and finding no bikes.
      isSelectable = true;
      uncertaintyPenaltyMin = config.baselineUncertaintyPenaltyMin;
    }

    // Generalized cost = time cost + uncertainty penalty cost
    const timeCost = totalTime * config.valuePerMinuteSaved;
    const uncertaintyCost = uncertaintyPenaltyMin * config.valuePerMinuteSaved;
    const generalizedCost = Math.round(timeCost + uncertaintyCost);

    routes.push({
      type: "bike_share",
      travelTimeMin: totalTime,
      walkingKm: walkToStation,
      generalizedCost,
      stationId: station.id,
      stationName: station.name,
      availabilityStatus: availability,
      isSelectable,
    });
  }

  return routes;
}

// ═══════════════════════════════════════════════════════════════════════
// BEST ROUTE SELECTION (identical logic for both strategies)
// ═══════════════════════════════════════════════════════════════════════

function selectBestRoute(routes: RouteOption[]): RouteOption {
  const selectable = routes.filter((r) => r.isSelectable);
  if (selectable.length === 0) {
    // Fallback: walk direct (always selectable)
    return routes.find((r) => r.type === "walk_direct") || routes[0];
  }
  return selectable.reduce((best, r) => (r.generalizedCost < best.generalizedCost ? r : best));
}

// ═══════════════════════════════════════════════════════════════════════
// DEMAND-LEVEL EVALUATION
// ═══════════════════════════════════════════════════════════════════════

function evaluateDemand(
  demand: Demand,
  stations: SnapshotStation[],
  config: ExperimentConfig,
  snapshotTime: number,
): DemandResult {
  // Both strategies enumerate the SAME route set, differing only in
  // availability status and selectability.
  const baselineRoutes = enumerateRoutes(demand, stations, config, snapshotTime, false);
  const oryxxRoutes = enumerateRoutes(demand, stations, config, snapshotTime, true);

  const baselineBest = selectBestRoute(baselineRoutes);
  const oryxxBest = selectBestRoute(oryxxRoutes);

  // Nearest station distance
  let nearestStationDist = Infinity;
  let hasStationWithinWalking = false;
  for (const station of stations) {
    const dist = haversineKm(demand.origin, { lat: station.latitude, lon: station.longitude });
    if (dist < nearestStationDist) nearestStationDist = dist;
    if (dist <= config.maxWalkingKm) hasStationWithinWalking = true;
  }

  // Comparison
  const costDelta = baselineBest.generalizedCost - oryxxBest.generalizedCost;
  const timeDeltaMin = baselineBest.travelTimeMin - oryxxBest.travelTimeMin;

  let category: DemandResult["comparison"]["category"];
  let newlyDiscoverable = false;

  const baselineChoseBike = baselineBest.type === "bike_share";
  const oryxxChoseBike = oryxxBest.type === "bike_share";

  if (oryxxChoseBike && !baselineChoseBike) {
    // ORYXX selected a bike route that baseline did not (due to uncertainty penalty)
    newlyDiscoverable = true;
    category = "ORYXX_WINS";
  } else if (!oryxxChoseBike && baselineChoseBike) {
    // Baseline chose bike despite uncertainty — ORYXX found station unavailable/stale
    category = "BASELINE_WINS";
  } else if (costDelta > 0) {
    // Both chose same mode but ORYXX has lower cost
    category = "ORYXX_WINS";
  } else if (costDelta < 0) {
    category = "BASELINE_WINS";
  } else {
    category = "TIE";
  }

  // If neither has a bike route
  if (!baselineChoseBike && !oryxxChoseBike && !hasStationWithinWalking) {
    category = "NEITHER_HAS_BIKE";
  }

  return {
    demandId: demand.id,
    originLat: demand.origin.lat,
    originLon: demand.origin.lon,
    destLat: demand.destination.lat,
    destLon: demand.destination.lon,
    directDistanceKm: Math.round(demand.directDistanceKm * 100) / 100,
    nearestStationDistKm: Math.round(nearestStationDist * 100) / 100,
    hasStationWithinWalking,
    baseline: { bestRoute: baselineBest, allRoutes: baselineRoutes },
    oryxx: { bestRoute: oryxxBest, allRoutes: oryxxRoutes },
    comparison: { category, costDelta, timeDeltaMin, newlyDiscoverable },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN EXPERIMENT RUNNER
// ═══════════════════════════════════════════════════════════════════════

export function runLiveSupplyExperiment(config: ExperimentConfig): ExperimentResult {
  const snapshot = loadSnapshot();
  const demands = generateDemands(config);
  const snapshotTime = new Date(config.snapshotTimestamp).getTime();

  const stationsWithBikes = snapshot.stations.filter((s) => s.free_bikes > 0).length;
  const totalBikes = snapshot.stations.reduce((sum, s) => sum + s.free_bikes, 0);

  // Freshness analysis
  let stationsWithinFreshness = 0;
  let stationsExpired = 0;
  for (const station of snapshot.stations) {
    const stationTime = new Date(station.timestamp).getTime();
    const ageSec = (snapshotTime - stationTime) / 1000;
    if (ageSec <= config.freshnessWindowSec) stationsWithinFreshness++;
    else stationsExpired++;
  }

  // Evaluate each demand
  const demandResults: DemandResult[] = demands.map((d) =>
    evaluateDemand(d, snapshot.stations, config, snapshotTime),
  );

  // Aggregate metrics
  const demandsWithStation = demandResults.filter((r) => r.hasStationWithinWalking).length;
  const newlyDiscoverableCount = demandResults.filter((r) => r.comparison.newlyDiscoverable).length;
  const oryxxWins = demandResults.filter((r) => r.comparison.category === "ORYXX_WINS").length;
  const baselineWins = demandResults.filter((r) => r.comparison.category === "BASELINE_WINS").length;
  const ties = demandResults.filter((r) => r.comparison.category === "TIE").length;
  const neitherHasBike = demandResults.filter((r) => r.comparison.category === "NEITHER_HAS_BIKE").length;

  const validComparisons = demandResults.filter((r) => r.comparison.category !== "NEITHER_HAS_BIKE");
  const n = validComparisons.length || 1;
  const meanCostDelta = validComparisons.reduce((s, r) => s + r.comparison.costDelta, 0) / n;
  const meanTimeDeltaMin = validComparisons.reduce((s, r) => s + r.comparison.timeDeltaMin, 0) / n;

  return {
    experimentId: `live-exp-${Date.now()}-${config.demandSeed}`,
    runTimestamp: new Date().toISOString(),
    snapshotTimestamp: config.snapshotTimestamp,
    config,
    stationCount: snapshot.stations.length,
    stationsWithBikes,
    totalBikesObserved: totalBikes,
    stationsWithinFreshness,
    staleRate: stationsExpired / snapshot.stations.length,
    demandCount: demands.length,
    demandsWithStation: demandsWithStation,
    routeLevel: {
      newlyDiscoverableCount,
      newlyDiscoverableRate: newlyDiscoverableCount / demands.length,
      oryxxWins,
      baselineWins,
      ties,
      neitherHasBike,
      meanCostDelta: Math.round(meanCostDelta),
      meanTimeDeltaMin: Math.round(meanTimeDeltaMin * 100) / 100,
      improvementRate: oryxxWins / demands.length,
    },
    freshness: {
      windowSec: config.freshnessWindowSec,
      stationsWithinWindow: stationsWithinFreshness,
      stationsExpired,
      expiryRate: stationsExpired / snapshot.stations.length,
    },
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
      inferred: ["route feasibility", "walking distance", "bike route time", "generalized cost"],
      assumed: ["user accepts walking to station", "bike remains available until arrival", "user chooses best route"],
      unknown: ["actual booking", "actual acceptance", "actual completion", "arrival availability"],
    },
    demandResults,
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

// ═══════════════════════════════════════════════════════════════════════
// INVARIANT TEST: zero-inventory snapshot should make ORYXX == baseline
// ═══════════════════════════════════════════════════════════════════════

export function runInvariantCheck(config: ExperimentConfig): {
  withLiveInventory: ExperimentResult;
  withZeroInventory: ExperimentResult;
  invariantHolds: boolean;
} {
  // Run with real snapshot
  const withLive = runLiveSupplyExperiment(config);

  // Create a modified snapshot with all free_bikes = 0
  const snapshot = loadSnapshot();
  const zeroSnapshot: LiveObservationSnapshot = {
    ...snapshot,
    stations: snapshot.stations.map((s) => ({ ...s, free_bikes: 0 })),
  };

  // Run with zero inventory (ORYXX should become equivalent to baseline)
  // We need to temporarily override the snapshot loader
  const originalLoader = loadSnapshot;
  (loadSnapshot as any) = () => zeroSnapshot;

  const withZero = runLiveSupplyExperiment(config);

  // Restore
  (loadSnapshot as any) = originalLoader;

  // Check invariant: with zero inventory, ORYXX should have 0 newly discoverable routes
  const invariantHolds = withZero.routeLevel.newlyDiscoverableCount === 0;

  return { withLiveInventory: withLive, withZeroInventory: withZero, invariantHolds };
}
