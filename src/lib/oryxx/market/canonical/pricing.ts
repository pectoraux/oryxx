// ORYXX — Price mechanisms.
//
// Three pricing rules. All produce a price in [reservationPrice, budget].
// Price is a TRANSFER — it does not create social value. The canonical welfare
// function (evaluate.ts) ensures userSurplus + supplierSurplus = value - cost,
// independent of price. This is acceptance criterion C.

import type { DemandRequest, SupplyOffer } from "../types";
import type { PriceMechanism } from "./types";

// What ordinary routing would charge this demand: direct rideshare at market rate.
export function ordinaryMarketPrice(d: DemandRequest): number {
  const km = Math.abs(d.origin.x - d.destination.x) + Math.abs(d.origin.y - d.destination.y);
  const base = 3.0;
  const perKm = d.kind === "container" ? 0.4 : d.kind === "pallet" ? 0.6 : d.kind === "parcel" ? 0.9 : 1.6;
  return Math.round((base + perKm * km) * 100) / 100;
}

// Negotiate a price in [reservationPrice, min(budget, ceiling)].
// Returns -1 if no feasible price (reservationPrice > ceiling).
export function negotiatePrice(
  d: DemandRequest,
  s: SupplyOffer,
  ceiling: number,
  mechanism: PriceMechanism,
): number {
  const reservation = Math.max(0, s.minCompensation);
  if (mechanism === "market") {
    // market price = ordinary rate, clamped to [reservation, budget]
    const mp = ordinaryMarketPrice(d);
    const p = Math.min(mp, d.budget);
    return p >= reservation ? Math.round(p * 100) / 100 : -1;
  }
  if (mechanism === "negotiated") {
    // deterministic split-the-difference, 50/50
    const ceil = Math.min(d.budget, ceiling);
    if (ceil < reservation) return -1;
    const p = reservation + (ceil - reservation) * 0.5;
    return Math.round(p * 100) / 100;
  }
  // oryxx: split biased toward user (45/55), i.e. user keeps slightly more
  const ceil = Math.min(d.budget, ceiling);
  if (ceil < reservation) return -1;
  const p = reservation + (ceil - reservation) * 0.45;
  return Math.round(p * 100) / 100;
}
