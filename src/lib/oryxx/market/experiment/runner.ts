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
  DecompositionDelta,
  SuperlinearityResult,
  SuperlinearityPoint,
} from "../canonical/types";
import { runOrdinary } from "../strategies/ordinary";
import { runMultimodal } from "../strategies/multimodal";
import { runPoolingFixed } from "../strategies/pooling-fixed";
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
      case "multimodal": {
        const r = runMultimodal(demands, supplies, world);
        m = r.metrics; matches = r.matches; break;
      }
      case "pooling-fixed": {
        const r = runPoolingFixed(demands, supplies, world);
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
      default:
        continue;
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
  decomposition: DecompositionDelta[];
  failureCases: SingleRunResult[];
  topOpportunities: TransportationOpportunity[];
  oryxxMomentsStats: {
    mean: number;
    median: number;
    p10: number;
    p90: number;
    std: number;
    totalAcrossSeeds: number;
  };
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
    ["oryxx", "multimodal"],
    ["oryxx", "pooling-fixed"],
    ["oryxx", "centralized"],
    ["clairvoyant", "oryxx"],
  ];
  for (const [left, right] of comparisons) {
    for (const metric of METRICS_TO_REPORT) {
      const leftSamples = runs.map((r) => (r.metrics as any)[left]?.[metric] ?? 0);
      const rightSamples = runs.map((r) => (r.metrics as any)[right]?.[metric] ?? 0);
      // skip if a strategy wasn't run
      if (leftSamples.every((v) => v === 0) && !runs[0]?.metrics[left]) continue;
      if (rightSamples.every((v) => v === 0) && !runs[0]?.metrics[right]) continue;
      pairedDiffs.push(pairedDifference(leftSamples, rightSamples, metric, `${left} - ${right}`));
    }
  }

  // advantage decomposition: B-A, C-B, D-C, E-D, F-E
  const decomposition = buildDecomposition(runs);

  // ORYXX moments stats (the clean thesis metric)
  const momentsSamples = runs.map((r) => r.metrics.oryxx?.oryxxMomentsCount ?? 0);
  const momentsStats = describe(momentsSamples);

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
    decomposition,
    failureCases,
    topOpportunities,
    oryxxMomentsStats: {
      mean: momentsStats.mean,
      median: momentsStats.median,
      p10: momentsStats.p10,
      p90: momentsStats.p90,
      std: momentsStats.std,
      totalAcrossSeeds: momentsSamples.reduce((a, b) => a + b, 0),
    },
    generatedAt: new Date().toISOString(),
  };
}

// Advantage decomposition: isolates each mechanism's marginal contribution.
// A (Ordinary) → B (Multimodal) → C (Pooling fixed) → D (Centralized) → E (ORYXX) → F (Exact)
//   B - A = value of multimodal routing (seeing all modes, no sharing)
//   C - B = value of physical coordination (sharing capacity, fixed prices)
//   D - C = value of negotiated pricing (economic optimization)
//   E - D = value of ORYXX market pricing specifically
//   F - E = remaining optimization gap
function buildDecomposition(runs: SingleRunResult[]): DecompositionDelta[] {
  const ladder: { left: StrategyId; right: StrategyId; comparison: string; label: string }[] = [
    { left: "multimodal", right: "ordinary", comparison: "B - A", label: "Value of multimodal routing" },
    { left: "pooling-fixed", right: "multimodal", comparison: "C - B", label: "Value of physical coordination (sharing capacity)" },
    { left: "centralized", right: "pooling-fixed", comparison: "D - C", label: "Value of negotiated pricing" },
    { left: "oryxx", right: "centralized", comparison: "E - D", label: "Value of ORYXX market pricing" },
    { left: "clairvoyant", right: "oryxx", comparison: "F - E", label: "Optimization gap (exact − heuristic)" },
  ];
  const out: DecompositionDelta[] = [];
  for (const step of ladder) {
    const leftSamples = runs.map((r) => (r.metrics as any)[step.left]?.totalRiskAdjustedWelfare ?? 0);
    const rightSamples = runs.map((r) => (r.metrics as any)[step.right]?.totalRiskAdjustedWelfare ?? 0);
    // skip if a strategy wasn't run for this config
    if (!runs[0]?.metrics[step.left] || !runs[0]?.metrics[step.right]) continue;
    const pd = pairedDifference(leftSamples, rightSamples, "totalRiskAdjustedWelfare", step.comparison);
    out.push({
      comparison: step.comparison,
      label: step.label,
      metric: "totalRiskAdjustedWelfare",
      mean: pd.mean,
      median: pd.median,
      p10: pd.p10,
      p90: pd.p90,
      winRate: pd.winRate,
      n: pd.n,
    });
  }
  return out;
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

// --- Superlinearity sweep ---------------------------------------------------
// The killer experiment: does ORYXX's advantage increase superlinearly with
// transportation information density? If the curve bends upward, there's a
// potential network effect. If it's linear, coordination helps proportionally.
// If it flattens, coordination saturates.
//
// We sweep one dimension at a time and measure ORYXX's incremental benefit
// (oryxxWelfare - ordinaryWelfare) + ORYXX moments count at each point.
export function runSuperlinearity(
  baseConfig: ExperimentConfig,
  dimension: "future-visibility" | "supply-density" | "demand-density" | "npd-density",
  values: number[],
  numSeedsPerPoint: number,
): SuperlinearityResult {
  const points: SuperlinearityPoint[] = [];
  const strategies = ["ordinary", "oryxx"] as StrategyId[];

  for (const v of values) {
    const cfg: ExperimentConfig = {
      ...baseConfig,
      world: { ...baseConfig.world },
      strategies,
      numSeeds: 1,
    };
    switch (dimension) {
      case "future-visibility":
        cfg.world.planningHorizonMin = v;
        break;
      case "supply-density":
        cfg.numDrivers = Math.round(baseConfig.numDrivers * v);
        cfg.numNPDs = Math.round(baseConfig.numNPDs * v);
        cfg.numTrucks = Math.round(baseConfig.numTrucks * v);
        break;
      case "demand-density":
        cfg.numDemands = v;
        break;
      case "npd-density":
        cfg.numNPDs = Math.round((v / 100) * cfg.numDemands);
        break;
    }

    let oryxxSum = 0, ordinarySum = 0, momentsSum = 0;
    for (let i = 0; i < numSeedsPerPoint; i++) {
      const run = runSingle({ ...cfg, numSeeds: 1 }, baseConfig.seed + i);
      oryxxSum += (run.metrics as any).oryxx?.totalRiskAdjustedWelfare ?? 0;
      ordinarySum += (run.metrics as any).ordinary?.totalRiskAdjustedWelfare ?? 0;
      momentsSum += (run.metrics as any).oryxx?.oryxxMomentsCount ?? 0;
    }
    const n = numSeedsPerPoint;
    const oryxxWelfare = oryxxSum / n;
    const ordinaryWelfare = ordinarySum / n;
    points.push({
      dimension,
      value: v,
      oryxxWelfare: Math.round(oryxxWelfare * 100) / 100,
      ordinaryWelfare: Math.round(ordinaryWelfare * 100) / 100,
      oryxxAdvantage: Math.round((oryxxWelfare - ordinaryWelfare) * 100) / 100,
      oryxxMoments: Math.round((momentsSum / n) * 10) / 10,
      n,
    });
  }

  // Fit a quadratic y = a*x² + b*x + c to the advantage curve.
  // If a > 0 (positive quadratic coefficient), the curve is convex → superlinear.
  const { coef, r2 } = fitQuadratic(
    points.map((p) => p.value),
    points.map((p) => p.oryxxAdvantage),
  );

  const isSuperlinear = coef > 0 && r2 > 0.85 && points.length >= 4;

  return {
    dimension,
    points,
    isSuperlinear,
    quadraticR2: Math.round(r2 * 1000) / 1000,
    quadraticCoef: Math.round(coef * 10000) / 10000,
    note: isSuperlinear
      ? `Advantage curve is convex (quadratic coefficient ${coef.toFixed(4)} > 0, R²=${r2.toFixed(3)}). This is consistent with a superlinear network effect — ORYXX's benefit grows faster than the information density increases.`
      : coef > 0
      ? `Quadratic coefficient is positive (${coef.toFixed(4)}) but R²=${r2.toFixed(3)} is too low to conclude superlinearity. The advantage may be approximately linear.`
      : `Advantage curve is concave or flat (quadratic coefficient ${coef.toFixed(4)} ≤ 0). Coordination benefit grows sublinearly or saturates — no evidence of a network effect on this dimension.`,
  };
}

// Least-squares quadratic fit: y = a*x² + b*x + c.
// Returns { coef: a, r2: R² }.
function fitQuadratic(xs: number[], ys: number[]): { coef: number; r2: number } {
  const n = xs.length;
  if (n < 3) return { coef: 0, r2: 0 };
  // normal equations for [sum(x^4), sum(x^3), sum(x^2); sum(x^3), sum(x^2), sum(x); sum(x^2), sum(x), n]
  let s4 = 0, s3 = 0, s2 = 0, s1 = 0, s0 = n;
  let sy2 = 0, sy1 = 0, sy0 = 0;
  let yMean = ys.reduce((a, b) => a + b, 0) / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    s4 += xs[i] ** 4; s3 += xs[i] ** 3; s2 += xs[i] ** 2; s1 += xs[i];
    sy2 += xs[i] ** 2 * ys[i]; sy1 += xs[i] * ys[i]; sy0 += ys[i];
  }
  // solve 3x3 system via Cramer's rule
  const A = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const Bcol = [sy2, sy1, sy0];
  const det = det3(A);
  if (Math.abs(det) < 1e-12) return { coef: 0, r2: 0 };
  const a = det3([Bcol, A[1], A[2]]) / det;
  const b = det3([A[0], Bcol, A[2]]) / det;
  const c = det3([A[0], A[1], Bcol]) / det;
  // R²
  for (let i = 0; i < n; i++) {
    const pred = a * xs[i] ** 2 + b * xs[i] + c;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { coef: a, r2 };
}

function det3(m: number[][]): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
       - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
       + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
