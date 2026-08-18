// ORYXX — World model: empty-km accounting.
//
// Computes the TOTAL empty vehicle-km for a strategy's outcome, given the
// world configuration. This is applied IDENTICALLY to every strategy — the
// only difference is which matches each strategy produced.
//
// Components:
//   1. Matched trips: each match incurs repositioning empty-km (world.repositionRatioAfterDrop
//      * operational km). For rideshare/truck this is the deadhead-back fraction.
//   2. Committed supply that drove but wasn't matched: drives anyway (deadhead), unless
//      world.committedTripExecutesIfUnmatched is false.
//   3. Potential NPDs that weren't matched: do NOT drive (the latent-supply saving), unless
//      world.npdActivatesIfUnmatched is true.
//   4. Transit: runs its schedule regardless (world.transitRunsRegardless). Empty seats
//      on transit are counted as unused capacity, not empty km (transit drives the route
//      whether or not anyone rides).

import type { DemandRequest, SupplyOffer } from "../types";
import type { TransportationEvaluation, WorldConfig, CanonicalMetrics } from "./types";
import { dist } from "./geometry";

export function computeEmptyKm(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
  matches: TransportationEvaluation[],
  world: WorldConfig,
): { emptyVehicleKm: number; deadheadKm: number } {
  let emptyKm = 0;

  // 1. matched trips: repositioning / deadhead-back
  const matchedSupplyIds = new Set(matches.map((m) => m.supplyId));
  for (const m of matches) {
    // rideshare-market synthetic supply: deadhead ratio applies
    const s = supplies.find((x) => x.id === m.supplyId);
    if (!s) {
      // RSM-* — treat as rideshare deadhead
      emptyKm += m.operationalVehicleKm * world.deadheadRatioRideshare;
      continue;
    }
    const ratio = s.kind === "truck" ? world.deadheadRatioTruck : world.deadheadRatioRideshare;
    emptyKm += m.operationalVehicleKm * ratio;
  }

  // 2. committed supply not matched
  for (const s of supplies) {
    if (s.kind === "transit") continue;
    if (matchedSupplyIds.has(s.id)) continue;
    // potential NPDs (not committed) only drive if matched, unless world says otherwise
    if (!s.isCommitted && !world.npdActivatesIfUnmatched) continue;
    // committed supply: drives anyway unless world says otherwise
    if (s.isCommitted && !world.committedTripExecutesIfUnmatched) continue;
    emptyKm += dist(s.origin, s.destination);
  }

  // deadhead is a subset of empty km (the post-dropoff repositioning portion)
  const deadhead = emptyKm * 0.5; // estimate; documented as model assumption

  return {
    emptyVehicleKm: Math.round(emptyKm * 100) / 100,
    deadheadKm: Math.round(deadhead * 100) / 100,
  };
}

// Total offered seat-capacity (for utilization). For ordinary routing, this
// is the (infinite) rideshare pool — we cap it at matched demands for fairness.
export function offeredSeatCapacity(
  supplies: SupplyOffer[],
  strategyId: string,
  matchedDemands: number,
  demands: DemandRequest[],
): number {
  if (strategyId === "ordinary") {
    // ordinary has an effectively-infinite rideshare pool; utilization is
    // best reported as matched / total-demandable. Use sum of party sizes.
    return demands.reduce((a, d) => a + d.partySize, 0);
  }
  return supplies
    .filter((s) => s.kind !== "transit" || true) // include transit capacity
    .reduce((a, s) => a + s.capacitySeats, 0);
}
