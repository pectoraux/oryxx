// ORYXX — Strategy C: Pooling (fixed price).
//
// Cross-demand capacity sharing IS allowed (a truck with 3 seats can serve
// multiple demands), but pricing is FIXED at market rate — no negotiation,
// no economic optimization. This isolates the value of PHYSICAL COORDINATION
// (sharing capacity) without the value of economic optimization (negotiated
// pricing that maximizes welfare).
//
// Uses the shared greedyAssign utility (welfare-greedy + 2-opt) with
// mechanism="market" (fixed prices). The welfare-greedy still picks the
// highest-welfare matches, but the price is always the market rate — so the
// welfare difference vs centralized (negotiated) isolates the value of
// negotiated pricing.

import type { DemandRequest, SupplyOffer } from "../types";
import type { CanonicalMetrics, WorldConfig, TransportationEvaluation } from "../canonical/types";
import { makeRideshareMarketSupply } from "../canonical/evaluate";
import { greedyAssign } from "./greedy";
import { buildMetrics } from "./ordinary";

export function runPoolingFixed(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  world: WorldConfig,
): { metrics: CanonicalMetrics; matches: TransportationEvaluation[] } {
  const t0 = Date.now();
  const augmented = [...supplies, ...demands.map(makeRideshareMarketSupply)];
  const { matches, feasiblePairCount, runtimeMs } = greedyAssign(demands, world, {
    supplies: augmented,
    mechanism: "market",
    localSearch: true,
    maxPasses: 3,
  });
  const metrics = buildMetrics("pooling-fixed", matches, demands, supplies, world, t0, feasiblePairCount, false);
  metrics.solverRuntimeMs = runtimeMs;
  return { metrics, matches };
}
