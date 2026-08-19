// ORYXX — Strategy B: Multimodal planner.
//
// Each demand independently picks the BEST feasible supply from ALL modes
// (rideshare, transit, carpool-NPD, truck). NO cross-demand sharing: each
// non-transit supply serves at most ONE demand. Transit is a public service
// and can serve many demands (capacity still respected, but it's not "pooled"
// in the coordination sense — each rider independently decides to take transit).
//
// This isolates the value of MULTIMODAL ROUTING (B - A): seeing transit/truck/
// carpool options, but without the ability to coordinate who-gets-what.
//
// Algorithm: process demands in order. For each demand, evaluate all feasible
// supplies (including its own RSM fallback). Pick the one with highest personal
// risk-adjusted welfare. Mark non-transit supplies as consumed (capacity → 0).
// Transit capacity is decremented but the line keeps running for others.

import type { DemandRequest, SupplyOffer } from "../types";
import type { CanonicalMetrics, WorldConfig, TransportationEvaluation } from "../canonical/types";
import { evaluate, makeRideshareMarketSupply } from "../canonical/evaluate";
import { buildMetrics } from "./ordinary";

export function runMultimodal(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  world: WorldConfig,
): { metrics: CanonicalMetrics; matches: TransportationEvaluation[] } {
  const t0 = Date.now();
  // augment with each demand's own RSM fallback
  const augmented = [...supplies, ...demands.map(makeRideshareMarketSupply)];
  const supplyById = new Map(augmented.map((s) => [s.id, { ...s }]));

  const matches: TransportationEvaluation[] = [];
  let feasiblePairCount = 0;

  for (const d of demands) {
    let best: TransportationEvaluation | null = null;
    for (const s of augmented) {
      // RSM-* are demand-private
      if (s.id.startsWith("RSM-") && s.id !== `RSM-${d.id}`) continue;
      const cur = supplyById.get(s.id)!;
      const ev = evaluate(d, s, cur.availableCapacity, world, "market");
      if (ev.feasible) {
        feasiblePairCount++;
        if (!best || ev.riskAdjustedWelfare > best.riskAdjustedWelfare) {
          best = ev;
        }
      }
    }
    if (best) {
      const s = supplyById.get(best.supplyId)!;
      // non-transit supply is consumed by this demand (no sharing)
      // transit capacity is decremented but the line stays available for others
      if (s.kind !== "transit") {
        s.availableCapacity = 0; // fully consumed — no sharing
      } else {
        s.availableCapacity = Math.max(0, s.availableCapacity - d.partySize);
      }
      matches.push(best);
    }
  }

  const metrics = buildMetrics("multimodal", matches, demands, supplies, world, t0, feasiblePairCount, false);
  return { metrics, matches };
}
