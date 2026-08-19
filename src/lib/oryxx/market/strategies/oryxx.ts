// ORYXX — Strategy C: ORYXX market.
//
// Cross-demand matching + latent supply + capacity + time + risk-adjusted
// pricing + execution probability. Welfare-greedy + 2-opt. Subsumes ordinary
// routing (rideshare-market fallback at exact market rate) but discovers
// latent-supply / transit / truck-backhaul opportunities.
//
// Uses the "oryxx" pricing mechanism (user-biased 45/55 split). This is the
// ONLY difference from centralized — same feasibility, same welfare function,
// same assignment algorithm. The pricing difference tests whether market
// pricing vs neutral negotiation changes outcomes.

import type { DemandRequest, SupplyOffer } from "../types";
import type { CanonicalMetrics, WorldConfig, TransportationEvaluation } from "../canonical/types";
import { makeRideshareMarketSupply } from "../canonical/evaluate";
import { greedyAssign } from "./greedy";
import { buildMetrics } from "./ordinary";

export function runOryxx(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  world: WorldConfig,
): { metrics: CanonicalMetrics; matches: TransportationEvaluation[] } {
  const t0 = Date.now();
  const augmented = [...supplies, ...demands.map(makeRideshareMarketSupply)];
  const { matches, feasiblePairCount, runtimeMs } = greedyAssign(demands, world, {
    supplies: augmented,
    mechanism: "oryxx",
    localSearch: true,
    maxPasses: 3,
  });
  const metrics = buildMetrics("oryxx", matches, demands, supplies, world, t0, feasiblePairCount, false);
  metrics.solverRuntimeMs = runtimeMs;
  return { metrics, matches };
}
