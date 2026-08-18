// ORYXX — Experiment runner.
//
// Runs multi-seed experiments, collecting per-seed metrics for each strategy.
// Computes statistics + paired differences. Extracts "ORYXX moments" and
// "where ORYXX loses" cases. Verifies invariants on every seed.
//
// The runner is the single source of truth for experiment results. The API
// and UI consume its output.

import type { DemandRequest, SupplyOffer } from "../types";
import { places, generateDemands, generateSupplies } from "../generate";
import type {
  ExperimentConfig,
  SingleRunResult,
  TransportationOpportunity,
  StrategyId,
  CanonicalMetrics,
  WorldConfig,
  SweepResult,
  SweepStatistics,
  PairedDiff,
} from "../canonical/types";
import { runOrdinary } from "../strategies/ordinary";
import { runCentralized } from "../strategies/centralized";
import { runOryxx } from "../strategies/oryxx";
import { runClairvoyant } from "../strategies/exact";
import { checkInvariants } from "./invariants";
import { describe, pairedDifference } from "./statistics";

export function runSingle(config: ExperimentConfig, seed: number): SingleRunResult {
  const ps = places(config.regionKm);
  const demands: DemandRequest[] = generateDemands({
    seed,
    n: config.numDemands,
    regionKm: config.regionKm,
    places: ps,
  });
  const supplies: SupplyOffer[] = generateSupplies({
    seed,
    numDrivers: config.numDrivers,
    numNPDs: config.numNPDs,
    numTrucks: config.numTrucks,
    numTransitLines: config.numTransitLines,
    regionKm: config.regionKm,
    places: ps,
  });

  const world = config.world;
  const metrics: Record<StrategyId, CanonicalMetrics> = {} as any;
  const matchesByStrategy: Record<StrategyId, any[]> = {} as any;

  for (const sid of config.strategies) {
    let m: CanonicalMetrics;
    let matches: any[];
    switch (sid) {
      case "ordinary": {
        const r = runOrdinary(demands, supplies, world);
        m = r.metrics; matches = r.matches; break;
      }
      case "centralized": {
        const r = runCentralized(demands, supplies, world);
        m = r.metrics; matches = r.matches; break;
      }
      case "oryxx": {
        const r = runOryxx(demands, supplies, world);
        m = r.metrics; matches = r.matches; break;
      }
      case "clairvoyant": {
        const r = runClairvoyant(demands, supplies, world, config.exactMaxDemands);
        m = r.metrics; matches = r.matches; break;
      }
    }
    metrics[sid] = m;
    matchesByStrategy[sid] = matches;
  }

  const inv = checkInvariants(demands, supplies, world, metrics as any);

  const opportunities = extractOpportunities(matchesByStrategy.oryxx ?? [], demands, supplies);

  return {
    seed,
    world,
    demands: demands.length,
    supplies: supplies.length,
    metrics: metrics as Record<StrategyId, CanonicalMetrics>,
    opportunities,
    invariantsPassed: inv.passed,
    invariantFailures: inv.failures,
  };
}

export function extractOpportunities(
  oryxxMatches: any[],
  demands: DemandRequest[],
  supplies: SupplyOffer[],
): TransportationOpportunity[] {
  return oryxxMatches
    .filter((m) => m.wouldBeMissedByOrdinary)
    .map((m) => {
      const d = demands.find((x) => x.id === m.demandId)!;
      const s = supplies.find((x) => x.id === m.supplyId);
      return {
        id: `${m.demandId}-${m.supplyId}`,
        demandId: m.demandId,
        supplyId: m.supplyId,
        origin: d.origin,
        destination: d.destination,
        departureWindow: { start: m.departure, end: m.departure },
        arrivalWindow: { start: m.arrival, end: m.arrival },
        availableCapacity: s?.availableCapacity ?? 0,
        detourKm: m.detourKm,
        detourMinutes: Math.round(m.detourKm * 2),
        probabilityOfExecution: m.executionProbability,
        reliability: m.reliability,
        supplierCost: m.supplierCost,
        reservationPrice: m.reservationPrice,
        userMaxPrice: m.userMaxPrice,
        negotiatedPrice: m.price,
        userSurplus: m.userSurplus,
        supplierSurplus: m.supplierSurplus,
        socialWelfare: m.socialSurplus,
        riskAdjustedWelfare: m.riskAdjustedWelfare,
        reasonWhyOrdinaryRoutingWouldMissIt: m.reasonOrdinaryWouldMiss ?? "Ordinary routing could not construct this match.",
        supplyKind: m.supplyKind,
      };
    })
    .sort((a, b) => b.riskAdjustedWelfare - a.riskAdjustedWelfare)
    .slice(0, 20);
}

export interface ExperimentResult {
  config: ExperimentConfig;
  runs: SingleRunResult[];
  statistics: ExperimentStatistics;
  pairedDiffs: PairedDiff[];
  failureCases: SingleRunResult[];
  topOpportunities: TransportationOpportunity[];
  generatedAt: string;
}

export interface ExperimentStatistics {
  // for each (strategy, metric) → SampleStats
  [key: string]: any;
}

const METRICS_TO_REPORT = [
  "matchingRate",
  "totalRiskAdjustedWelfare",
  "totalSocialSurplus",
  "totalUserCost",
  "emptyVehicleKm",
  "seatUtilization",
  "avgTravelTimeMin",
  "avgDetourKm",
  "unservedDemandValue",
  "matchedDemands",
];

export function runExperiment(config: ExperimentConfig): ExperimentResult {
  const runs: SingleRunResult[] = [];
  for (let i = 0; i < config.numSeeds; i++) {
    const seed = config.seed + i;
    const run = runSingle(config, seed);
    runs.push(run);
  }

  // statistics per (strategy, metric)
  const statistics: ExperimentStatistics = {};
  for (const sid of config.strategies) {
    for (const metric of METRICS_TO_REPORT) {
      const samples = runs.map((r) => (r.metrics as any)[sid]?.[metric] ?? 0);
      statistics[`${sid}.${metric}`] = describe(samples);
    }
  }

  // paired differences: ORYXX vs each other, Clairvoyant vs ORYXX
  const pairedDiffs: PairedDiff[] = [];
  const comparisons: [StrategyId, StrategyId][] = [
    ["oryxx", "ordinary"],
    ["oryxx", "centralized"],
    ["clairvoyant", "oryxx"],
  ];
  for (const [left, right] of comparisons) {
    for (const metric of METRICS_TO_REPORT) {
      const leftSamples = runs.map((r) => (r.metrics as any)[left]?.[metric] ?? 0);
      const rightSamples = runs.map((r) => (r.metrics as any)[right]?.[metric] ?? 0);
      pairedDiffs.push(pairedDifference(leftSamples, rightSamples, metric, `${left} - ${right}`));
    }
  }

  // failure cases: seeds where ORYXX welfare < ordinary welfare
  const failureCases = runs.filter((r) => {
    const o = (r.metrics as any).oryxx?.totalRiskAdjustedWelfare ?? 0;
    const b = (r.metrics as any).ordinary?.totalRiskAdjustedWelfare ?? 0;
    return o < b - 0.5;
  });

  // top opportunities (from the first run as representative)
  const topOpportunities = runs[0]?.opportunities ?? [];

  return {
    config,
    runs,
    statistics,
    pairedDiffs,
    failureCases,
    topOpportunities,
    generatedAt: new Date().toISOString(),
  };
}

// --- Sweeps (sensitivity analysis) -----------------------------------------
export function runSweep(
  baseConfig: ExperimentConfig,
  experiment: "planning-horizon" | "npd-density" | "demand-density" | "supply-ratio",
  values: number[],
  numSeedsPerPoint: number,
): SweepResult {
  const points: any[] = [];
  const statistics: SweepStatistics[] = [];

  for (const v of values) {
    const pointResults: SingleRunResult[] = [];
    const cfg = applySweepValue(baseConfig, experiment, v);
    for (let i = 0; i < numSeedsPerPoint; i++) {
      const seed = baseConfig.seed + i;
      pointResults.push(runSingle({ ...cfg, numSeeds: 1 }, seed));
    }
    points.push({ label: sweepLabel(experiment, v), value: v, results: pointResults });

    // statistics for each strategy/metric at this point
    for (const sid of cfg.strategies) {
      for (const metric of METRICS_TO_REPORT) {
        const samples = pointResults.map((r) => (r.metrics as any)[sid]?.[metric] ?? 0);
        const s = describe(samples);
        statistics.push({
          experiment,
          pointLabel: sweepLabel(experiment, v),
          pointValue: v,
          strategyId: sid,
          metric,
          mean: s.mean,
          median: s.median,
          p10: s.p10,
          p25: s.p25,
          p75: s.p75,
          p90: s.p90,
          std: s.std,
          ci95Low: s.ci95Low,
          ci95High: s.ci95High,
          n: s.n,
        });
      }
    }
  }

  return { experiment, points, statistics };
}

function applySweepValue(base: ExperimentConfig, experiment: string, v: number): ExperimentConfig {
  const cfg: ExperimentConfig = { ...base, world: { ...base.world } };
  switch (experiment) {
    case "planning-horizon":
      cfg.world.planningHorizonMin = v;
      break;
    case "npd-density":
      cfg.numNPDs = Math.round((v / 100) * cfg.numDemands);
      break;
    case "demand-density":
      cfg.numDemands = v;
      break;
    case "supply-ratio":
      // v is the ratio; scale drivers/NPDs/trucks
      cfg.numDrivers = Math.round(base.numDrivers * v);
      cfg.numNPDs = Math.round(base.numNPDs * v);
      cfg.numTrucks = Math.round(base.numTrucks * v);
      break;
  }
  return cfg;
}

function sweepLabel(experiment: string, v: number): string {
  switch (experiment) {
    case "planning-horizon":
      if (v === 0) return "0 min";
      if (v < 60) return `${v} min`;
      if (v < 1440) return `${Math.round(v / 60 * 10) / 10}h`;
      return `${Math.round(v / 1440 * 10) / 10}d`;
    case "npd-density": return `${v}%`;
    case "demand-density": return `${v}`;
    case "supply-ratio": return `${v}x`;
    default: return String(v);
  }
}
