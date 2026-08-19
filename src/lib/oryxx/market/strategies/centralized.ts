// ORYXX — Strategy B: Centralized coordination.
//
// All demand and supply visible. A benevolent dispatcher maximizes total
// risk-adjusted welfare via greedy + 2-opt. No market pricing (uses
// deterministic negotiated prices, 50/50 split). Measures the value of
// COORDINATION ITSELF — without ORYXX's market mechanism.

import type { DemandRequest, SupplyOffer } from "../types";
import type { CanonicalMetrics, WorldConfig, TransportationEvaluation } from "../canonical/types";
import { makeRideshareMarketSupply } from "../canonical/evaluate";
import { greedyAssign } from "./greedy";
import { buildMetrics } from "./ordinary";

export function runCentralized(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  world: WorldConfig,
): { metrics: CanonicalMetrics; matches: TransportationEvaluation[] } {
  const t0 = Date.now();
  // centralized sees all real supply PLUS the rideshare-market fallback
  // (so it can always serve affordable demands via rideshare, like ordinary,
  //  but also discovers latent supply — the coordination value)
  const augmented = [...supplies, ...demands.map(makeRideshareMarketSupply)];
  const { matches, feasiblePairCount, runtimeMs } = greedyAssign(demands, world, {
    supplies: augmented,
    mechanism: "negotiated",
    localSearch: true,
    maxPasses: 3,
  });
  const metrics = buildMetrics("centralized", matches, demands, supplies, world, t0, feasiblePairCount, false);
  metrics.solverRuntimeMs = runtimeMs;
  return { metrics, matches };
}
