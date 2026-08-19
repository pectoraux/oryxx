// ORYXX — Canonical evaluation primitive.
//
// This is THE single function every strategy calls to evaluate a (demand,
// supply) pair. It enforces identical feasibility + welfare definitions
// across all mechanisms (acceptance criteria A, B, C, F, G).
//
// Welfare definition (canonical, documented):
//   userSurplus       = value - price          (value = willingness to pay)
//   supplierSurplus   = price - supplierCost    (cost = real operating cost)
//   socialSurplus     = userSurplus + supplierSurplus
//                                                  = value - supplierCost
//                                                  (price cancels — no fake value)
//   riskAdjustedWelfare = socialSurplus
//                         * executionProbability
//                         * (reliabilityWeight + (1 - reliabilityWeight) * reliability)
//
// A pure price transfer between user and supplier does NOT change socialSurplus
// or riskAdjustedWelfare. This is the invariant that prevents artificial welfare.

import type { DemandRequest, SupplyOffer } from "../types";
import type { TransportationEvaluation, WorldConfig, PriceMechanism } from "./types";
import { checkFeasibility } from "./feasibility";
import { negotiatePrice, ordinaryMarketPrice } from "./pricing";
import { dist } from "./geometry";

export function evaluate(
  d: DemandRequest,
  s: SupplyOffer,
  availableCapacity: number,
  world: WorldConfig,
  mechanism: PriceMechanism,
): TransportationEvaluation {
  const f = checkFeasibility(d, s, availableCapacity, world);
  const directDistanceKm = f.directDistanceKm;

  if (!f.feasible) {
    return {
      demandId: d.id,
      supplyId: s.id,
      feasible: false,
      reasonIfInfeasible: f.reasonIfInfeasible,
      departure: 0,
      arrival: 0,
      travelTimeMin: 0,
      directDistanceKm,
      operationalVehicleKm: 0,
      emptyVehicleKm: 0,
      detourKm: 0,
      supplierCost: 0,
      userMaxPrice: d.budget,
      reservationPrice: s.minCompensation,
      price: 0,
      userSurplus: 0,
      supplierSurplus: 0,
      socialSurplus: 0,
      executionProbability: s.executionProbability,
      reliability: s.reliability,
      riskAdjustedWelfare: 0,
      supplyKind: s.kind,
      wouldBeMissedByOrdinary: false,
      reasonOrdinaryWouldMiss: undefined,
    };
  }

  // ceiling for negotiated price — never above ordinary market rate (so ORYXX
  // can't manufacture welfare by charging above market)
  const ordinary = ordinaryMarketPrice(d);
  const ceiling = ordinary;
  const price = negotiatePrice(d, s, ceiling, mechanism);
  if (price < 0) {
    return {
      demandId: d.id,
      supplyId: s.id,
      feasible: false,
      reasonIfInfeasible: "price-infeasible (reservation > ceiling)",
      departure: 0,
      arrival: 0,
      travelTimeMin: 0,
      directDistanceKm,
      operationalVehicleKm: 0,
      emptyVehicleKm: 0,
      detourKm: f.detourKm,
      supplierCost: 0,
      userMaxPrice: d.budget,
      reservationPrice: s.minCompensation,
      price: 0,
      userSurplus: 0,
      supplierSurplus: 0,
      socialSurplus: 0,
      executionProbability: s.executionProbability,
      reliability: s.reliability,
      riskAdjustedWelfare: 0,
      supplyKind: s.kind,
      wouldBeMissedByOrdinary: false,
    };
  }

  const supplierCost = Math.round(f.operationalVehicleKm * s.costPerKm * 100) / 100;
  const userSurplus = Math.round((d.value - price) * 100) / 100;
  const supplierSurplus = Math.round((price - supplierCost) * 100) / 100;
  const socialSurplus = Math.round((userSurplus + supplierSurplus) * 100) / 100;
  // = value - supplierCost (price cancels) — verified by invariant

  const rw = world.reliabilityWeight;
  const riskFactor = s.executionProbability * (rw + (1 - rw) * s.reliability);
  const riskAdjustedWelfare = Math.round(socialSurplus * riskFactor * 100) / 100;

  // empty vehicle-km attributable to THIS match (depends on world assumptions)
  const emptyVehicleKm = computeEmptyKmForMatch(s, f.operationalVehicleKm, world);

  // Would ordinary routing miss this opportunity?
  const wouldMiss = s.kind !== "rideshare" || !s.id.startsWith("RSM-");
  const reasonMiss = wouldMiss ? reasonOrdinaryMisses(s, d) : undefined;

  return {
    demandId: d.id,
    supplyId: s.id,
    feasible: true,
    departure: f.departAt,
    arrival: f.arriveAt,
    travelTimeMin: f.travelTimeMin,
    directDistanceKm,
    operationalVehicleKm: f.operationalVehicleKm,
    emptyVehicleKm,
    detourKm: f.detourKm,
    supplierCost,
    userMaxPrice: d.budget,
    reservationPrice: s.minCompensation,
    price,
    userSurplus,
    supplierSurplus,
    socialSurplus,
    executionProbability: s.executionProbability,
    reliability: s.reliability,
    riskAdjustedWelfare,
    supplyKind: s.kind,
    wouldBeMissedByOrdinary: wouldMiss,
    reasonOrdinaryWouldMiss: reasonMiss,
  };
}

// Empty-km attributable to a single match, given world assumptions.
function computeEmptyKmForMatch(s: SupplyOffer, operationalKm: number, world: WorldConfig): number {
  if (s.kind === "transit") return 0; // transit runs regardless; empty seats aren't "empty km" attributable here
  // post-dropoff repositioning fraction
  const reposition = operationalKm * world.repositionRatioAfterDrop;
  return Math.round(reposition * 100) / 100;
}

function reasonOrdinaryMisses(s: SupplyOffer, d: DemandRequest): string {
  switch (s.kind) {
    case "carpool-npd":
      return s.isCommitted
        ? `Ordinary routing treats the driver and rider independently. ORYXX observed that a commuter was already driving ${s.originName}→${s.destName} with spare capacity.`
        : `Ordinary routing has no concept of latent supply. ORYXX activated a potential trip (an NPD that only drives if matched), avoiding a deadhead.`;
    case "truck":
      return `Ordinary routing treats freight as a dedicated shipment. ORYXX observed a truck already traveling ${s.originName}→${s.destName} with spare capacity — a backhaul opportunity.`;
    case "transit":
      return `Ordinary routing defaults to on-demand rideshare. ORYXX found a scheduled transit line whose route serves this trip within the time window at lower cost.`;
    default:
      return `Ordinary routing's information model could not construct this match.`;
  }
}

// Helper: the "rideshare-market" synthetic supply that ORYXX uses as a neutral
// fallback (so ORYXX subsumes ordinary routing). This is NOT used by the
// ordinary strategy itself.
export function makeRideshareMarketSupply(d: DemandRequest): SupplyOffer {
  const ordinary = ordinaryMarketPrice(d);
  return {
    id: `RSM-${d.id}`,
    kind: "rideshare",
    origin: { x: d.origin.x, y: d.origin.y },
    destination: { x: d.destination.x, y: d.destination.y },
    originName: d.originName,
    destName: d.destName,
    departure: d.window.start,
    capacitySeats: d.partySize,
    availableCapacity: d.partySize,
    minCompensation: ordinary, // exact market rate
    detourToleranceKm: 0,
    executionProbability: 0.9,
    reliability: 0.86,
    costPerKm: 0.35,
    isCommitted: true,
    route: [{ x: d.origin.x, y: d.origin.y }, { x: d.destination.x, y: d.destination.y }],
  };
}
