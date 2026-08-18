// ORYXX — Statistics for multi-seed experiment analysis.
//
// Computes mean, median, percentiles, std, 95% CI, and paired differences.
// Never reports a single cherry-picked seed.

export interface SampleStats {
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  std: number;
  ci95Low: number;
  ci95High: number;
  n: number;
  min: number;
  max: number;
}

export function describe(samples: number[]): SampleStats {
  const n = samples.length;
  if (n === 0) {
    return { mean: 0, median: 0, p10: 0, p25: 0, p75: 0, p90: 0, std: 0, ci95Low: 0, ci95High: 0, n: 0, min: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const std = Math.sqrt(variance);
  // 95% CI: mean ± 1.96 * (std / sqrt(n))
  const se = std / Math.sqrt(n);
  const ci95Low = mean - 1.96 * se;
  const ci95High = mean + 1.96 * se;
  return {
    mean: round(mean),
    median: percentile(sorted, 50),
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    std: round(std),
    ci95Low: round(ci95Low),
    ci95High: round(ci95High),
    n,
    min: sorted[0],
    max: sorted[n - 1],
  };
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round(sorted[lo]);
  const frac = idx - lo;
  return round(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

// Paired difference: for each seed, compute (leftMetric - rightMetric).
// Reports the distribution + winRate (fraction of seeds where left > right).
export interface PairedDiffStats {
  metric: string;
  comparison: string; // "oryxx - ordinary"
  mean: number;
  median: number;
  p10: number;
  p90: number;
  std: number;
  winRate: number; // fraction of seeds where left > right
  n: number;
  leftWins: number;
  ties: number;
  rightWins: number;
}

export function pairedDifference(
  left: number[],
  right: number[],
  metric: string,
  comparison: string,
): PairedDiffStats {
  const n = Math.min(left.length, right.length);
  const diffs: number[] = [];
  let leftWins = 0, ties = 0, rightWins = 0;
  for (let i = 0; i < n; i++) {
    const d = left[i] - right[i];
    diffs.push(d);
    if (d > 0.001) leftWins++;
    else if (d < -0.001) rightWins++;
    else ties++;
  }
  const s = describe(diffs);
  return {
    metric,
    comparison,
    mean: s.mean,
    median: s.median,
    p10: s.p10,
    p90: s.p90,
    std: s.std,
    winRate: n > 0 ? round(leftWins / n) : 0,
    n,
    leftWins,
    ties,
    rightWins,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
