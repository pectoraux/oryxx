// ORYXX — Ordinary routing baseline.
//
// Represents "what happens today without ORYXX": every demand independently
// calls a rideshare at market rate. No matching, no carpooling, no latent
// supply, no truck-backhaul discovery. Vehicles run mostly empty (1 demand per
// vehicle), drivers deadhead back. This is the control group the ORYXX market
// clearing is measured against.

import type {
  DemandRequest,
  SupplyOffer,
  Match,
} from "./types";
import { ordinaryRideshareCost } from "./match";
import { dist } from "./generate";

const SPEED_KMH = 38;
const RIDESHARE_EMPTY_RETURN_RATIO = 0.7; // driver deadheads back ~70% of trip km

export function ordinaryRouting(demands: DemandRequest[], supplies: SupplyOffer[]): Match[] {
  const matches: Match[] = [];
  for (const d of demands) {
    const ordinary = ordinaryRideshareCost(d);
    if (ordinary > d.budget) continue; // user can't afford it → unserved
    const travel = Math.max(2, Math.round((dist(d.origin, d.destination) / SPEED_KMH) * 60));
    matches.push({
      demandId: d.id,
      supplyId: "rideshare-market",
      supplyKind: "rideshare",
      price: ordinary,
      welfare: Math.round((d.value - ordinary) * 100) / 100,
      userSurplus: Math.round((d.value - ordinary) * 100) / 100,
      driverSurplus: Math.round((ordinary - dist(d.origin, d.destination) * 0.35) * 100) / 100,
      detourKm: 0,
      departAt: d.window.start,
      arriveAt: d.window.start + travel,
      travelTimeMin: travel,
      ordinaryCost: ordinary,
      savingVsOrdinary: 0,
    });
  }
  // references supply "rideshare-market" conceptually; supplies array is the
  // committed fleet which ordinary routing does NOT use for matching.
  return matches;
  // NOTE: supplies are intentionally ignored here — that is the point.
  // Ordinary routing leaves the entire latent-supply + truck-backhaul + transit
  // opportunity graph untapped.
}

// Unused-supply km that ordinary routing incurs: every committed driver/truck
// that had no one to carry still drove (deadhead). Plus each matched rideshare
// deadheads back.
export function ordinaryEmptyKm(demands: DemandRequest[], supplies: SupplyOffer[], matches: Match[]): number {
  let km = 0;
  // matched rideshares deadhead back
  for (const m of matches) {
    km += dist(demands.find((d) => d.id === m.demandId)!.origin, demands.find((d) => d.id === m.demandId)!.destination) * RIDESHARE_EMPTY_RETURN_RATIO;
  }
  // committed drivers/trucks with nobody matched drive anyway (empty)
  const matchedSupplyIds = new Set(matches.map((m) => m.supplyId));
  for (const s of supplies) {
    if (s.kind === "transit") continue; // transit runs its schedule regardless
    if (s.isCommitted && !matchedSupplyIds.has(s.id)) {
      km += dist(s.origin, s.destination);
    }
  }
  return Math.round(km * 100) / 100;
}
