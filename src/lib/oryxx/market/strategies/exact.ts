// ORYXX — Strategy D: Clairvoyant optimum (exact branch-and-bound).
//
// For small instances (demands <= ~16) this finds the TRUE optimum assignment
// maximizing total risk-adjusted welfare, subject to identical constraints.
// For larger instances it falls back to the centralized heuristic and is
// labelled HEURISTIC (not EXACT) — the UI must distinguish these.
//
// The problem is a generalized assignment problem (each demand -> one supply,
// capacity-constrained). NP-hard in general but tractable for small N with
// branch-and-bound + good pruning. We branch on demands (in order of fewest
// feasible options first, a classic MRV heuristic) and prune branches whose
// optimistic upper bound can't beat the incumbent.

import type { DemandRequest, SupplyOffer } from "../types";
import type { CanonicalMetrics, WorldConfig, TransportationEvaluation } from "../canonical/types";
import { evaluate, makeRideshareMarketSupply } from "../canonical/evaluate";
import { buildMetrics } from "./ordinary";
import { runCentralized } from "./centralized";

export const EXACT_MAX_DEMANDS = 16; // beyond this, B&B is too slow; fall back

interface FeasibleOption {
  ev: TransportationEvaluation;
  welfare: number;
}

export function runClairvoyant(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  world: WorldConfig,
  exactMaxDemands: number = EXACT_MAX_DEMANDS,
): { metrics: CanonicalMetrics; matches: TransportationEvaluation[]; exact: boolean; note: string } {
  const t0 = Date.now();
  const useExact = demands.length <= exactMaxDemands;

  if (!useExact) {
    // fall back to centralized heuristic, labelled as heuristic (not exact)
    const { metrics, matches } = runCentralized(demands, supplies, world);
    return {
      metrics: { ...metrics, strategyId: "clairvoyant" },
      matches,
      exact: false,
      note: `Exact B&B is intractable for ${demands.length} demands (max ${exactMaxDemands}). Fell back to centralized heuristic — this is a HEURISTIC upper bound, not a true optimum.`,
    };
  }

  // Build feasible options per demand
  const augmented = [...supplies, ...demands.map((d) => makeRideshareMarketSupply(d))];
  const supplyById = new Map(augmented.map((s) => [s.id, s]));
  const demandOptions = new Map<string, FeasibleOption[]>();
  let feasiblePairCount = 0;

  for (const d of demands) {
    const opts: FeasibleOption[] = [];
    for (const s of augmented) {
      const ev = evaluate(d, s, s.capacitySeats, world, "negotiated");
      if (ev.feasible && ev.riskAdjustedWelfare > 0) {
        opts.push({ ev, welfare: ev.riskAdjustedWelfare });
        feasiblePairCount++;
      }
    }
    opts.sort((a, b) => b.welfare - a.welfare);
    demandOptions.set(d.id, opts);
  }

  // MRV ordering: demands with fewest options first (prunes faster)
  const order = [...demands].sort((a, b) => {
    const oa = demandOptions.get(a.id)!.length;
    const ob = demandOptions.get(b.id)!.length;
    return oa - ob;
  });

  let bestWelfare = 0;
  let bestAssignment: Map<string, TransportationEvaluation> | null = null;

  // capacity tracker
  const capacity = new Map<string, number>();
  for (const s of augmented) capacity.set(s.id, s.capacitySeats);

  // optimistic upper bound: sum of best-remaining-welfare for each unmatched demand
  function upperBound(idx: number, currentWelfare: number): number {
    let ub = currentWelfare;
    for (let i = idx; i < order.length; i++) {
      const opts = demandOptions.get(order[i].id)!;
      // best option whose supply still has capacity (approximate: just take max)
      if (opts.length > 0) ub += opts[0].welfare;
    }
    return ub;
  }

  function branch(idx: number, currentWelfare: number, assignment: Map<string, TransportationEvaluation>) {
    if (idx >= order.length) {
      if (currentWelfare > bestWelfare) {
        bestWelfare = currentWelfare;
        bestAssignment = new Map(assignment);
      }
      return;
    }
    // prune
    if (upperBound(idx, currentWelfare) <= bestWelfare) return;

    const d = order[idx];
    const opts = demandOptions.get(d.id)!;

    // option 0: leave this demand unmatched (if matching it would reduce welfare)
    branch(idx + 1, currentWelfare, assignment);

    for (const opt of opts) {
      const s = supplyById.get(opt.ev.supplyId)!;
      const cap = capacity.get(opt.ev.supplyId)!;
      if (cap < d.partySize) continue;
      capacity.set(opt.ev.supplyId, cap - d.partySize);
      assignment.set(d.id, opt.ev);
      branch(idx + 1, currentWelfare + opt.welfare, assignment);
      assignment.delete(d.id);
      capacity.set(opt.ev.supplyId, cap);
    }
  }

  branch(0, 0, new Map());

  const matches: TransportationEvaluation[] = bestAssignment
    ? [...bestAssignment.values()]
    : [];

  const metrics = buildMetrics("clairvoyant", matches, demands, supplies, world, t0, feasiblePairCount, true);
  return {
    metrics,
    matches,
    exact: true,
    note: `Exact branch-and-bound over ${demands.length} demands × ${augmented.length} supplies. Optimal assignment found (${matches.length} matched, total risk-adjusted welfare ${metrics.totalRiskAdjustedWelfare}).`,
  };
}
