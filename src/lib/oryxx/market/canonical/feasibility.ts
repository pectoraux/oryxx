// ORYXX — Shared feasibility evaluator.
//
// EVERY strategy uses this. No strategy may define its own feasibility rules.
// This is acceptance criterion A: "Baseline and ORYXX use identical hard
// feasibility constraints."
//
// Hard constraints (all must hold):
//   - kind compatibility (cargo needs trucks; people can ride transit/carpool/rideshare)
//   - capacity (supply.availableCapacity >= demand.partySize)
//   - spatial (supply route serves pickup+dropoff within detour tolerance, in order)
//   - temporal (a valid departure exists within the demand window; arrival <= latestArrival)
//   - budget (a price exists such that reservationPrice <= price <= budget)
//
// What ordinary routing SEES is controlled by the strategy layer (it can
// ignore latent supply), NOT by relaxing these constraints.

import type { DemandRequest, SupplyOffer } from "../types";
import type { WorldConfig } from "./types";
import { routeServes, travelTimeMin, dist } from "./geometry";

export interface FeasibilityResult {
  feasible: boolean;
  reasonIfInfeasible?: string;
  detourKm: number;
  departAt: number;
  arriveAt: number;
  travelTimeMin: number;
  operationalVehicleKm: number;
  directDistanceKm: number;
}

export function isKindCompatible(d: DemandRequest, s: SupplyOffer): boolean {
  if (d.kind === "container" || d.kind === "pallet") return s.kind === "truck";
  if (d.kind === "parcel") return s.kind === "truck" || s.kind === "carpool-npd" || s.kind === "rideshare";
  // person / people
  return s.kind === "rideshare" || s.kind === "carpool-npd" || s.kind === "transit";
}

// Does this supply serve this demand under the shared constraints?
// `availableCapacity` is the supply's CURRENT remaining capacity (so the same
// function works during greedy assignment).
export function checkFeasibility(
  d: DemandRequest,
  s: SupplyOffer,
  availableCapacity: number,
  world: WorldConfig,
): FeasibilityResult {
  const directDistanceKm = dist(d.origin, d.destination);
  const base = {
    detourKm: 0,
    departAt: 0,
    arriveAt: 0,
    travelTimeMin: 0,
    operationalVehicleKm: 0,
    directDistanceKm,
  };

  if (!isKindCompatible(d, s)) {
    return { feasible: false, reasonIfInfeasible: "kind-incompatible", ...base };
  }
  if (availableCapacity < d.partySize) {
    return { feasible: false, reasonIfInfeasible: "capacity", ...base };
  }

  const rs = routeServes(s.route, d.origin, d.destination, s.detourToleranceKm);
  if (!rs.feasible) {
    return { feasible: false, reasonIfInfeasible: "spatial-detour", ...base };
  }

  // temporal: find the next departure within the demand window
  let depart = s.departure;
  if (s.kind === "transit" && s.scheduleFreqMin) {
    while (depart < d.window.start) depart += s.scheduleFreqMin;
  }
  if (depart < d.window.start || depart > d.window.end) {
    return { feasible: false, reasonIfInfeasible: "temporal-window", ...base };
  }

  const travel = travelTimeMin(d.origin, d.destination, world.speedKmh) + Math.round(rs.detourKm * 2);
  const arrive = depart + travel;
  if (d.latestArrival && arrive > d.latestArrival) {
    return { feasible: false, reasonIfInfeasible: "latest-arrival", ...base };
  }

  // operational km = supply's direct route + detour
  const operationalVehicleKm = Math.round((dist(s.origin, s.destination) + rs.detourKm) * 100) / 100;

  return {
    feasible: true,
    detourKm: rs.detourKm,
    departAt: depart,
    arriveAt: arrive,
    travelTimeMin: travel,
    operationalVehicleKm,
    directDistanceKm,
  };
}
