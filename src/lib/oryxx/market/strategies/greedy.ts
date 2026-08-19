// ORYXX — Shared greedy assignment utility.
//
// Both centralized coordination and ORYXX use a welfare-greedy construction
// over the canonical evaluations. The difference between the two strategies
// is which supplies they can SEE (both see all; ordinary doesn't) and the
// pricing mechanism. This helper avoids duplicating the assignment logic.
//
// It does NOT enforce a pricing mechanism — callers pass pre-evaluated pairs.

import type { DemandRequest, SupplyOffer } from "../types";
import type { TransportationEvaluation, WorldConfig } from "../canonical/types";
import { evaluate } from "../canonical/evaluate";

export interface GreedyOptions {
  // the supply pool this strategy can see (ordinary = RSM only; centralized/oryxx = all + RSM)
  supplies: SupplyOffer[];
  // pricing mechanism for evaluation
  mechanism: "market" | "negotiated" | "oryxx";
  // whether to run 2-opt local improvement after greedy
  localSearch: boolean;
  // max 2-opt passes
  maxPasses?: number;
}

export function greedyAssign(
  demands: DemandRequest[],
  world: WorldConfig,
  opts: GreedyOptions,
): { matches: TransportationEvaluation[]; feasiblePairCount: number; runtimeMs: number } {
  const t0 = Date.now();
  const supplyById = new Map(opts.supplies.map((s) => [s.id, { ...s }]));
  const demandById = new Map(demands.map((d) => [d.id, d]));

  // enumerate all feasible (demand, supply) evaluations
  // RSM-* synthetic supplies are demand-private fallbacks: RSM-Dx can only
  // serve demand Dx. This prevents cross-demand RSM matching (which would
  // break the price invariant — RSM-Dx's reservation is ordinary(Dx), not
  // ordinary(Dy)).
  const allPairs: TransportationEvaluation[] = [];
  let feasiblePairCount = 0;
  for (const d of demands) {
    for (const s of opts.supplies) {
      if (s.id.startsWith("RSM-") && s.id !== `RSM-${d.id}`) continue;
      const cur = supplyById.get(s.id)!;
      const ev = evaluate(d, s, cur.availableCapacity, world, opts.mechanism);
      if (ev.feasible) {
        feasiblePairCount++;
        allPairs.push(ev);
      }
    }
  }
  // sort by risk-adjusted welfare descending
  allPairs.sort((a, b) => b.riskAdjustedWelfare - a.riskAdjustedWelfare);

  const matchedDemandIds = new Set<string>();
  const matches: TransportationEvaluation[] = [];

  // Phase 1: greedy
  for (const ev of allPairs) {
    if (matchedDemandIds.has(ev.demandId)) continue;
    const s = supplyById.get(ev.supplyId)!;
    const d = demandById.get(ev.demandId)!;
    if (s.availableCapacity < d.partySize) continue;
    // re-evaluate with current capacity (price/welfare may shift slightly; but
    // capacity is the only dynamic input — keep ev for speed, capacity checked above)
    s.availableCapacity -= d.partySize;
    matchedDemandIds.add(ev.demandId);
    matches.push(ev);
  }

  // Phase 2: 2-opt local improvement
  if (opts.localSearch) {
    const maxPasses = opts.maxPasses ?? 3;
    const unmatched = demands.filter((d) => !matchedDemandIds.has(d.id));
    let improved = true;
    let passes = 0;
    while (improved && passes < maxPasses) {
      improved = false;
      passes++;
      for (const d of unmatched) {
        if (matchedDemandIds.has(d.id)) continue;
        for (let mi = 0; mi < matches.length; mi++) {
          const m = matches[mi];
          const s = supplyById.get(m.supplyId)!;
          if (!s) continue;
          // RSM-* are demand-private
          if (s.id.startsWith("RSM-") && s.id !== `RSM-${d.id}`) continue;
          const prevD = demandById.get(m.demandId)!;
          const freeCap = s.availableCapacity + prevD.partySize;
          if (freeCap < d.partySize) continue;
          const evNew = evaluate(d, s, freeCap, world, opts.mechanism);
          if (!evNew.feasible) continue;
          if (evNew.riskAdjustedWelfare > m.riskAdjustedWelfare + 0.5) {
            s.availableCapacity += prevD.partySize - d.partySize;
            matchedDemandIds.delete(prevD.id);
            matchedDemandIds.add(d.id);
            matches[mi] = evNew;
            improved = true;
          }
        }
      }
    }
  }

  return { matches, feasiblePairCount, runtimeMs: Date.now() - t0 };
}
