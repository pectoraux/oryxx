// ORYXX — Strategy A: Ordinary routing.
//
// Each demand independently calls a direct on-demand rideshare at market rate.
// No cross-demand coordination, no latent-supply discovery, no market clearing.
//
// IMPORTANT (acceptance criterion B): ordinary routing uses the SAME canonical
// feasibility + welfare as every other strategy. It does NOT get easier rules.
// It is simply BLIND to non-rideshare supply — it never considers carpool-NPD,
// truck, or transit. That blindness is the strategy's defining limitation, not a
// relaxation of constraints.

import type { DemandRequest, SupplyOffer } from "../types";
import type { CanonicalMetrics, WorldConfig, TransportationEvaluation, StrategyId } from "../canonical/types";
import { evaluate, makeRideshareMarketSupply } from "../canonical/evaluate";
import { computeEmptyKm, offeredSeatCapacity } from "../canonical/world";
import { ordinaryMarketPrice } from "../canonical/pricing";

export function runOrdinary(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  world: WorldConfig,
): { metrics: CanonicalMetrics; matches: TransportationEvaluation[] } {
  const t0 = Date.now();
  const matches: TransportationEvaluation[] = [];
  let feasiblePairCount = 0;

  for (const d of demands) {
    // ordinary routing's ONLY supply option: a direct on-demand rideshare at
    // market rate. Modeled as the synthetic rideshare-market supply.
    const rsm = makeRideshareMarketSupply(d);
    const ev = evaluate(d, rsm, rsm.availableCapacity, world, "market");
    if (ev.feasible) {
      feasiblePairCount++;
      matches.push(ev);
    }
  }

  const metrics = buildMetrics("ordinary", matches, demands, supplies, world, t0, feasiblePairCount, false);
  return { metrics, matches };
}

export function buildMetrics(
  strategyId: StrategyId,
  matches: TransportationEvaluation[],
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  world: WorldConfig,
  t0: number,
  feasiblePairCount: number,
  isExact: boolean,
): CanonicalMetrics {
  const matchedIds = new Set(matches.map((m) => m.demandId));
  const matchedDemands = demands.filter((d) => matchedIds.has(d.id));
  const unmatched = demands.filter((d) => !matchedIds.has(d.id));

  const totalUserCost = r2(matches.reduce((a, m) => a + m.price, 0));
  const totalSupplierEarnings = r2(matches.reduce((a, m) => a + m.price, 0)); // = totalUserCost
  const totalSupplierCost = r2(matches.reduce((a, m) => a + m.supplierCost, 0));
  const totalUserSurplus = r2(matches.reduce((a, m) => a + m.userSurplus, 0));
  const totalSupplierSurplus = r2(matches.reduce((a, m) => a + m.supplierSurplus, 0));
  const totalSocialSurplus = r2(matches.reduce((a, m) => a + m.socialSurplus, 0));
  const totalRiskAdjustedWelfare = r2(matches.reduce((a, m) => a + m.riskAdjustedWelfare, 0));

  const { emptyVehicleKm, deadheadKm } = computeEmptyKm(demands, supplies, matches, world);

  const offeredSeats = offeredSeatCapacity(supplies, strategyId, matchedDemands.length, demands);
  const usedSeats = matchedDemands.reduce((a, d) => a + d.partySize, 0);
  const seatUtilization = offeredSeats > 0 ? r3(usedSeats / offeredSeats) : 0;

  const avgTravelTimeMin = matches.length > 0
    ? Math.round(matches.reduce((a, m) => a + m.travelTimeMin, 0) / matches.length)
    : 0;
  const avgDetourKm = matches.length > 0
    ? r2(matches.reduce((a, m) => a + m.detourKm, 0) / matches.length)
    : 0;
  const unservedDemandValue = r2(unmatched.reduce((a, d) => a + d.value, 0));

  return {
    strategyId,
    matchedDemands: matchedDemands.length,
    unmatchedDemands: unmatched.length,
    totalDemands: demands.length,
    matchingRate: r3(matchedDemands.length / Math.max(1, demands.length)),
    totalUserCost,
    totalSupplierEarnings,
    totalSupplierCost,
    totalUserSurplus,
    totalSupplierSurplus,
    totalSocialSurplus,
    totalRiskAdjustedWelfare,
    seatUtilization,
    emptyVehicleKm,
    deadheadKm,
    avgTravelTimeMin,
    avgDetourKm,
    unservedDemandValue,
    solverRuntimeMs: Date.now() - t0,
    pairCount: demands.length * supplies.length,
    feasiblePairCount,
    isExact,
    evaluations: matches,
  };
}

function r2(n: number): number { return Math.round(n * 100) / 100; }
function r3(n: number): number { return Math.round(n * 1000) / 1000; }

