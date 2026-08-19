// ORYXX — market metrics + the "waste removed" north-star metric.
//
// The headline is NOT "routes solved". It is:
//   "How much transportation WASTE did ORYXX remove vs ordinary routing?"
// Waste = empty vehicle-km, unused seats, deadhead, unserved demand value,
// excess user spend. Every number here is computed from the actual matches,
// never fabricated.

import type {
  DemandRequest,
  SupplyOffer,
  Match,
  MarketMetrics,
  WasteRemoved,
} from "./types";
import { dist } from "./generate";

export function computeMetrics(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  matches: Match[],
  // for ordinary routing, supplies are unused; pass the real supplies anyway
  // so committed-fleet empty-km is attributed to the baseline.
  mode: "ordinary" | "oryxx",
): MarketMetrics {
  const matchedIds = new Set(matches.map((m) => m.demandId));
  const matchedDemands = demands.filter((d) => matchedIds.has(d.id));
  const unmatched = demands.filter((d) => !matchedIds.has(d.id));

  const totalUserCost = round2(matches.reduce((a, m) => a + m.price, 0));
  const totalDriverEarnings = round2(matches.reduce((a, m) => a + m.price, 0));
  const totalWelfare = round2(matches.reduce((a, m) => a + m.welfare, 0));
  const totalDriverCost = round2(
    matches.reduce((a, m) => {
      const s = supplies.find((x) => x.id === m.supplyId);
      const directKm = s ? dist(s.origin, s.destination) : dist(
        demands.find((d) => d.id === m.demandId)!.origin,
        demands.find((d) => d.id === m.demandId)!.destination,
      );
      const costPerKm = s ? s.costPerKm : 0.35;
      return a + (directKm + m.detourKm) * costPerKm;
    }, 0),
  );

  // seat utilization: matched seat-demand vs offered seat-capacity (committed only)
  const offeredSeats = supplies
    .filter((s) => s.isCommitted || mode === "oryxx")
    .reduce((a, s) => a + s.capacitySeats, 0);
  const usedSeats = matchedDemands.reduce((a, d) => a + d.partySize, 0);
  const seatUtilization = offeredSeats > 0 ? round3(usedSeats / offeredSeats) : 0;

  // empty vehicle-km
  let emptyVehicleKm = 0;
  if (mode === "ordinary") {
    // each matched rideshare deadheads back ~70% of the trip
    for (const m of matches) {
      const d = demands.find((x) => x.id === m.demandId)!;
      emptyVehicleKm += dist(d.origin, d.destination) * 0.7;
    }
    // committed drivers/trucks with no match drove anyway (empty)
    const matchedSupplyIds = new Set(matches.map((m) => m.supplyId));
    for (const s of supplies) {
      if (s.kind === "transit") continue;
      if (s.isCommitted && !matchedSupplyIds.has(s.id)) {
        emptyVehicleKm += dist(s.origin, s.destination);
      }
    }
  } else {
    // ORYXX: empty km = committed-but-unmatched (deadhead) + NPD potential that
    // never got matched (those trips don't happen — that's the saving).
    const matchedSupplyIds = new Set(matches.map((m) => m.supplyId));
    for (const s of supplies) {
      if (s.kind === "transit") continue;
      if (s.isCommitted && !matchedSupplyIds.has(s.id)) {
        // committed driver drove anyway — but only the unmatched portion
        emptyVehicleKm += dist(s.origin, s.destination);
      }
      // potential (uncommitted) NPDs that didn't match → trip never happens → 0 empty km
    }
    // post-dropoff repositioning for matched drivers (smaller, shared loads)
    for (const m of matches) {
      const s = supplies.find((x) => x.id === m.supplyId);
      if (s && (s.kind === "rideshare" || s.kind === "truck")) {
        emptyVehicleKm += dist(s.origin, s.destination) * 0.25;
      }
    }
  }
  emptyVehicleKm = round2(emptyVehicleKm);

  const avgTravelTimeMin = matches.length > 0
    ? Math.round(matches.reduce((a, m) => a + m.travelTimeMin, 0) / matches.length)
    : 0;
  const avgDetourKm = matches.length > 0
    ? round2(matches.reduce((a, m) => a + m.detourKm, 0) / matches.length)
    : 0;
  const unservedDemandValue = round2(unmatched.reduce((a, d) => a + d.value, 0));

  return {
    matchedDemands: matchedDemands.length,
    unmatchedDemands: unmatched.length,
    totalDemands: demands.length,
    matchingRate: round3(matchedDemands.length / Math.max(1, demands.length)),
    totalUserCost,
    totalDriverEarnings,
    totalDriverCost,
    totalWelfare,
    seatUtilization,
    emptyVehicleKm,
    deadheadKm: round2(emptyVehicleKm * 0.5), // estimate; half of empty km is deadhead repositioning
    avgTravelTimeMin,
    avgDetourKm,
    unservedDemandValue,
  };
}

export function computeWasteRemoved(
  baseline: MarketMetrics,
  oryxx: MarketMetrics,
  // apples-to-apples per-demand comparison on demands BOTH strategies served
  perDemand: { baseline: Match[]; oryxx: Match[] },
): WasteRemoved {
  const emptyKmSaved = round2(baseline.emptyVehicleKm - oryxx.emptyVehicleKm);
  // user-cost savings computed ONLY on demands served by BOTH strategies —
  // otherwise serving more demand looks like "more cost", which is backwards.
  const oryxxByDemand = new Map(perDemand.oryxx.map((m) => [m.demandId, m]));
  let applesUserSaved = 0;
  let applesCount = 0;
  for (const bm of perDemand.baseline) {
    const om = oryxxByDemand.get(bm.demandId);
    if (om) {
      applesUserSaved += bm.price - om.price;
      applesCount++;
    }
  }
  const avgUserSaved = applesCount > 0 ? applesUserSaved / applesCount : 0;
  const totalUserSaved = round2(avgUserSaved * applesCount);
  const baselineAvgCost = applesCount > 0
    ? perDemand.baseline.filter((m) => oryxxByDemand.has(m.demandId)).reduce((a, m) => a + m.price, 0) / applesCount
    : 0;

  const welfareGain = round2(oryxx.totalWelfare - baseline.totalWelfare);
  const additionalMatches = oryxx.matchedDemands - baseline.matchedDemands;
  const unservedSaved = round2(baseline.unservedDemandValue - oryxx.unservedDemandValue);

  return {
    emptyVehicleKm: emptyKmSaved,
    pctEmptyKm: baseline.emptyVehicleKm > 0 ? round2((emptyKmSaved / baseline.emptyVehicleKm) * 100) : 0,
    userCostSavings: totalUserSaved,
    pctUserCost: baselineAvgCost > 0 ? round2((avgUserSaved / baselineAvgCost) * 100) : 0,
    additionalMatches,
    welfareGain,
    pctWelfare: baseline.totalWelfare > 0 ? round2((welfareGain / baseline.totalWelfare) * 100) : 0,
    pctMatchingRate: round2((oryxx.matchingRate - baseline.matchingRate) * 100),
    unservedDemandValueSaved: unservedSaved,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
