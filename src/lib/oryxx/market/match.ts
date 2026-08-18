// ORYXX — Market clearing engine.
//
// This is the intellectual core that distinguishes ORYXX from a route planner.
// Given a set of DEMAND and a set of SUPPLY, find an assignment of demands to
// supplies that MAXIMIZES TOTAL WELFARE subject to:
//   - each demand matched at most once
//   - each supply's assigned partySize-sum <= capacity
//   - spatial feasibility (route serves pickup+dropoff within detour tolerance)
//   - temporal feasibility (departure within demand window; transit headway)
//   - budget >= price >= minCompensation (price is the negotiated split)
//   - kind compatibility (parcels/pallets/containers need truck capacity)
//
// Algorithm: greedy construction by welfare, then a local 2-opt swap pass.
// This is a HEURISTIC, not a proven optimum (see solverNote in results).
// For a prototype at this scale it is fast and produces real, comparable
// numbers. A production version would use min-cost max-flow or an LP solver.

import type {
  DemandRequest,
  SupplyOffer,
  Match,
} from "./types";
import { dist, routeServes } from "./generate";

const SPEED_KMH = 38; // average urban speed

function travelTimeMin(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(2, Math.round((dist(a, b) / SPEED_KMH) * 60));
}

// What ordinary routing would charge this demand: a direct rideshare at market
// rate. This is the baseline the "ORYXX moment" is measured against.
export function ordinaryRideshareCost(d: DemandRequest): number {
  const km = dist(d.origin, d.destination);
  const base = 3.0;
  const perKm = d.kind === "container" ? 0.4 : d.kind === "pallet" ? 0.6 : d.kind === "parcel" ? 0.9 : 1.6;
  return Math.round((base + perKm * km) * 100) / 100;
}

interface FeasiblePair {
  demandId: string;
  supplyId: string;
  detourKm: number;
  departAt: number;
  arriveAt: number;
  travelTimeMin: number;
  price: number;
  welfare: number;
  userSurplus: number;
  driverSurplus: number;
}

// Negotiated price: split-the-difference between minCompensation and budget,
// adjusted by execution probability (risk-adjusted driver floor) and weighted
// slightly toward the user (so ORYXX is visibly cheaper than ordinary).
// SPECIAL CASE: the synthetic "rideshare-market" supply (RSM-*) charges EXACTLY
// the ordinary market rate — it is the neutral fallback, neither discounted nor
// premium. Latent supply must beat it on welfare to be chosen.
function negotiatePrice(d: DemandRequest, s: SupplyOffer, ordinaryCost: number): number {
  if (s.id.startsWith("RSM-")) {
    // market rideshare: exact ordinary rate, if affordable
    return ordinaryCost <= d.budget ? Math.round(ordinaryCost * 100) / 100 : -1;
  }
  const driverFloor = s.minCompensation / Math.max(0.5, s.executionProbability);
  const ceiling = Math.min(d.budget, ordinaryCost * 0.95);
  if (ceiling < driverFloor) return -1; // infeasible
  // split the surplus between floor and ceiling, bias toward user (45/55)
  const split = 0.45;
  const price = driverFloor + (ceiling - driverFloor) * split;
  return Math.round(price * 100) / 100;
}

function isKindCompatible(d: DemandRequest, s: SupplyOffer): boolean {
  if (d.kind === "container" || d.kind === "pallet") return s.kind === "truck";
  if (d.kind === "parcel") return s.kind === "truck" || s.kind === "carpool-npd" || s.kind === "rideshare";
  // person/people: rideshare, carpool-npd, transit
  return s.kind === "rideshare" || s.kind === "carpool-npd" || s.kind === "transit";
}

function enumerateFeasible(demands: DemandRequest[], supplies: SupplyOffer[]): FeasiblePair[] {
  const pairs: FeasiblePair[] = [];
  for (const d of demands) {
    const ordinary = ordinaryRideshareCost(d);
    for (const s of supplies) {
      if (!isKindCompatible(d, s)) continue;
      if (s.availableCapacity < d.partySize) continue;
      const rs = routeServes(s.route, d.origin, d.destination, s.detourToleranceKm);
      if (!rs.feasible) continue;
      // temporal feasibility: find the next departure of s within d.window
      let depart = s.departure;
      if (s.kind === "transit" && s.scheduleFreqMin) {
        while (depart < d.window.start) depart += s.scheduleFreqMin;
      }
      if (depart < d.window.start || depart > d.window.end) continue;
      const price = negotiatePrice(d, s, ordinary);
      if (price < 0) continue;
      const travel = travelTimeMin(d.origin, d.destination) + Math.round(rs.detourKm * 2);
      const arrive = depart + travel;
      if (d.latestArrival && arrive > d.latestArrival) continue;
      const driverCost = (dist(s.origin, s.destination) + rs.detourKm) * s.costPerKm;
      const userSurplus = d.value - price;
      const driverSurplus = price - driverCost;
      // welfare weights execution probability + reliability (honest about risk)
      const riskAdj = s.executionProbability * (0.6 + 0.4 * s.reliability);
      const welfare = Math.round((userSurplus + driverSurplus) * riskAdj * 100) / 100;
      if (welfare <= 0) continue;
      pairs.push({
        demandId: d.id,
        supplyId: s.id,
        detourKm: rs.detourKm,
        departAt: depart,
        arriveAt: arrive,
        travelTimeMin: travel,
        price,
        welfare,
        userSurplus: Math.round(userSurplus * 100) / 100,
        driverSurplus: Math.round(driverSurplus * 100) / 100,
      });
    }
  }
  return pairs;
}

export interface ClearResult {
  matches: Match[];
  // demands that could not be feasibly matched
  unmatchedDemandIds: string[];
}

export function clearMarket(
  demands: DemandRequest[],
  supplies: SupplyOffer[],
): ClearResult {
  // ORYXX subsumes ordinary routing: for each demand, add a synthetic
  // "rideshare-market" supply (infinite on-demand pool at ordinary cost) so the
  // matcher can ALWAYS serve the demand via rideshare, and only picks a
  // committed/latent/transit/truck alternative when it yields higher welfare.
  // This is what makes the comparison fair: both strategies can use rideshare;
  // only ORYXX also sees the latent-supply opportunity graph.
  const augmented: SupplyOffer[] = [...supplies];
  for (const d of demands) {
    const ordinary = ordinaryRideshareCost(d);
    augmented.push({
      id: `RSM-${d.id}`,
      kind: "rideshare",
      origin: { x: d.origin.x, y: d.origin.y },
      destination: { x: d.destination.x, y: d.destination.y },
      originName: d.originName,
      destName: d.destName,
      departure: d.window.start,
      capacitySeats: d.partySize,
      availableCapacity: d.partySize,
      // The market rideshare charges exactly the ordinary rate (no discount,
      // no premium). Set minCompensation below ordinary so negotiatePrice's
      // split-the-difference lands AT ordinary — making RSM the welfare-neutral
      // fallback that latent supply must beat.
      minCompensation: ordinary * 0.7,
      detourToleranceKm: 0,
      executionProbability: 0.9,
      reliability: 0.86,
      costPerKm: 0.35,
      isCommitted: true,
      route: [{ x: d.origin.x, y: d.origin.y }, { x: d.destination.x, y: d.destination.y }],
    });
  }

  // work on a copy so we can mutate availableCapacity
  const supplyById = new Map(augmented.map((s) => [s.id, { ...s }]));
  const demandById = new Map(demands.map((d) => [d.id, d]));
  const pairs = enumerateFeasible(demands, augmented);
  // sort by welfare descending (greedy)
  pairs.sort((a, b) => b.welfare - a.welfare);

  const matchedDemandIds = new Set<string>();
  const matches: Match[] = [];

  // Phase 1: greedy by welfare
  for (const p of pairs) {
    if (matchedDemandIds.has(p.demandId)) continue;
    const s = supplyById.get(p.supplyId)!;
    const d = demandById.get(p.demandId)!;
    if (s.availableCapacity < d.partySize) continue;
    s.availableCapacity -= d.partySize;
    matchedDemandIds.add(p.demandId);
    const ordinary = ordinaryRideshareCost(d);
    const isMarketRideshare = s.id.startsWith("RSM-");
    matches.push({
      demandId: p.demandId,
      supplyId: isMarketRideshare ? "rideshare-market" : p.supplyId,
      supplyKind: s.kind,
      price: p.price,
      welfare: p.welfare,
      userSurplus: p.userSurplus,
      driverSurplus: p.driverSurplus,
      detourKm: p.detourKm,
      departAt: p.departAt,
      arriveAt: p.arriveAt,
      travelTimeMin: p.travelTimeMin,
      ordinaryCost: ordinary,
      savingVsOrdinary: Math.round((ordinary - p.price) * 100) / 100,
    });
  }

  // Phase 2: local 2-opt improvement.
  // Try to replace a low-welfare match with an unmatched demand using the
  // same supply if it raises total welfare. Bounded passes to stay fast.
  const unmatched = demands.filter((d) => !matchedDemandIds.has(d.id));
  let improved = true;
  let passes = 0;
  while (improved && passes < 3) {
    improved = false;
    passes++;
    for (const d of unmatched) {
      if (matchedDemandIds.has(d.id)) continue;
      const ordinary = ordinaryRideshareCost(d);
      // find any supply with a current match whose replacement by d raises welfare
      for (let mi = 0; mi < matches.length; mi++) {
        const m = matches[mi];
        const s = supplyById.get(m.supplyId === "rideshare-market" ? `RSM-${m.demandId}` : m.supplyId)!;
        // free capacity if we drop the current match
        const prevD = demandById.get(m.demandId)!;
        const freeCap = s.availableCapacity + prevD.partySize;
        if (freeCap < d.partySize) continue;
        // feasibility for (d, s)
        const rs = routeServes(s.route, d.origin, d.destination, s.detourToleranceKm);
        if (!rs.feasible) continue;
        let depart = s.departure;
        if (s.kind === "transit" && s.scheduleFreqMin) {
          while (depart < d.window.start) depart += s.scheduleFreqMin;
        }
        if (depart < d.window.start || depart > d.window.end) continue;
        const price = negotiatePrice(d, s, ordinary);
        if (price < 0) continue;
        const travel = travelTimeMin(d.origin, d.destination) + Math.round(rs.detourKm * 2);
        const driverCost = (dist(s.origin, s.destination) + rs.detourKm) * s.costPerKm;
        const riskAdj = s.executionProbability * (0.6 + 0.4 * s.reliability);
        const newWelfare = Math.round(((d.value - price) + (price - driverCost)) * riskAdj * 100) / 100;
        if (newWelfare > m.welfare + 0.5) {
          // do the swap
          s.availableCapacity += prevD.partySize - d.partySize;
          matchedDemandIds.delete(prevD.id);
          matchedDemandIds.add(d.id);
          const isMarketRideshare = s.id.startsWith("RSM-");
          matches[mi] = {
            demandId: d.id,
            supplyId: isMarketRideshare ? "rideshare-market" : s.id,
            supplyKind: s.kind,
            price,
            welfare: newWelfare,
            userSurplus: Math.round((d.value - price) * 100) / 100,
            driverSurplus: Math.round((price - driverCost) * 100) / 100,
            detourKm: rs.detourKm,
            departAt: depart,
            arriveAt: depart + travel,
            travelTimeMin: travel,
            ordinaryCost: ordinary,
            savingVsOrdinary: Math.round((ordinary - price) * 100) / 100,
          };
          improved = true;
        }
      }
    }
  }

  const unmatchedDemandIds = demands.filter((d) => !matchedDemandIds.has(d.id)).map((d) => d.id);
  return { matches, unmatchedDemandIds };
}
