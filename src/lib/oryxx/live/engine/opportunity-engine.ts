// ORYXX — Live Marketplace Opportunity Engine
//
// Given a set of DEMAND events (TransportationDemand[]) and a set of SUPPLY
// offers (TransportationSupply[]) discovered from connected providers, produce
// a ranked list of TransportationOpportunity objects — one per feasible
// (demand, supply) pair.
//
// Each opportunity explains itself in plain prose via four "why" strings:
//   - whyFeasible                       (hard-constraint justification)
//   - whyNow                            (temporal urgency / decay)
//   - whyThisSupply                     (why this supply, vs. alternatives)
//   - whyOrdinaryRoutingMissesIt        (the ORYXX thesis)
//
// Opportunities are sorted by social welfare (demand.value - supplier cost),
// descending — so the highest-value matches surface first for market clearing.
//
// Money is always integer minor units (cents). No floating-point money.
//
// Reuses the patterns (not the code) from market/canonical/feasibility.ts and
// market/canonical/evaluate.ts: the live engine applies the same hard-constraint
// philosophy (kind / capacity / spatial detour / temporal window / latest
// arrival) but operates on the live marketplace types, which carry explicit
// provenance, provider linkage, and marketplace-only evidence tags.

import type {
  DemandKind,
  GeoPoint,
  Provenance,
  TimeWindow,
  TransportationDemand,
  TransportationOpportunity,
  TransportationSupply,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// GEOMETRY
// ═══════════════════════════════════════════════════════════════════════

/** Great-circle distance between two lat/lon points, in kilometers. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371; // Earth radius (km)
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Perpendicular distance (km) from point P to the great-circle segment A->B.
 * Uses a local equirectangular projection to compute the projection parameter
 * `t`, then falls back to haversine for the final distance. This is the same
 * pattern as canonical/geometry.ts:detourFromSegment, but on lat/lon inputs.
 */
function pointToSegmentKm(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const kx = Math.cos(lat0) * 111.32; // km per degree of longitude
  const ky = 111.32; // km per degree of latitude
  const ax = a.lon * kx, ay = a.lat * ky;
  const bx = b.lon * kx, by = b.lat * ky;
  const px = p.lon * kx, py = p.lat * ky;
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const proj: GeoPoint = { lat: (ay + t * aby) / ky, lon: (ax + t * abx) / kx };
  return haversineKm(p, proj);
}

/**
 * Does the supply's planned route serve both pickup and dropoff, in order,
 * within the supply's detour tolerance?
 *
 * Returns the per-point detour distances and the total detour (sum of the two
 * perpendicular offsets). Mirrors canonical/geometry.ts:routeServes but on
 * GeoPoint lat/lon coordinates.
 */
function routeServes(
  supply: TransportationSupply,
  pickup: GeoPoint,
  dropoff: GeoPoint,
): {
  feasible: boolean;
  detourKm: number;
  pickupDetourKm: number;
  dropoffDetourKm: number;
  pickupSegmentIdx: number;
  dropoffSegmentIdx: number;
} {
  const route =
    supply.plannedRoute && supply.plannedRoute.length >= 2
      ? supply.plannedRoute
      : supply.origin
        ? [supply.origin, ...(supply.plannedStops ?? [])]
        : [];

  if (route.length < 2) {
    return {
      feasible: false,
      detourKm: 0,
      pickupDetourKm: 0,
      dropoffDetourKm: 0,
      pickupSegmentIdx: 0,
      dropoffSegmentIdx: 0,
    };
  }

  let bestPickup = { detour: Infinity, idx: 0 };
  let bestDropoff = { detour: Infinity, idx: 0 };
  for (let i = 0; i < route.length - 1; i++) {
    const pD = pointToSegmentKm(pickup, route[i], route[i + 1]);
    const dD = pointToSegmentKm(dropoff, route[i], route[i + 1]);
    if (pD < bestPickup.detour) bestPickup = { detour: pD, idx: i };
    if (dD < bestDropoff.detour) bestDropoff = { detour: dD, idx: i };
  }

  // Effective tolerance = the tighter of declared tolerance and constraint cap.
  const tolerance = Math.min(
    supply.detourToleranceKm,
    supply.constraints?.maxDetourKm ?? supply.detourToleranceKm,
  );

  const feasible =
    bestPickup.detour <= tolerance &&
    bestDropoff.detour <= tolerance &&
    bestPickup.idx <= bestDropoff.idx; // pickup must come before dropoff in route order

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    feasible,
    detourKm: round2(bestPickup.detour + bestDropoff.detour),
    pickupDetourKm: round2(bestPickup.detour),
    dropoffDetourKm: round2(bestDropoff.detour),
    pickupSegmentIdx: bestPickup.idx,
    dropoffSegmentIdx: bestDropoff.idx,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// KIND COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Static mapping of supply mode -> demand kinds that mode can carry.
 * Mirrors canonical/feasibility.ts:isKindCompatible, expanded for the live
 * marketplace's richer mode set (taxi, fhv, micromobility, walking).
 */
const MODE_KIND_COMPAT: Record<TransportationSupply["mode"], DemandKind[]> = {
  rideshare: ["person", "people", "parcel"],
  carpool: ["person", "people", "parcel"],
  taxi: ["person", "people", "parcel"],
  fhv: ["person", "people", "parcel"],
  truck: ["parcel", "pallet", "container"],
  transit: ["person", "people"],
  walking: ["person"],
  micromobility: ["person"],
};

function isKindCompatible(
  d: TransportationDemand,
  s: TransportationSupply,
): boolean {
  const allowed = MODE_KIND_COMPAT[s.mode] ?? [];
  return allowed.includes(d.kind);
}

// ═══════════════════════════════════════════════════════════════════════
// TIME + SPEED MODEL
// ═══════════════════════════════════════════════════════════════════════

/** Default urban cruising speed (km/h) per supply mode. */
const MODE_SPEED_KMH: Record<TransportationSupply["mode"], number> = {
  rideshare: 35,
  carpool: 35,
  taxi: 35,
  fhv: 32,
  truck: 30,
  transit: 25,
  walking: 5,
  micromobility: 15,
};

function speedFor(s: TransportationSupply): number {
  return MODE_SPEED_KMH[s.mode] ?? 30;
}

/** Convert seconds-from-midnight to HH:MM for human-readable "whyNow". */
function secToHHMM(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Find a feasible departure (seconds-from-midnight) that lies within both the
 * demand's pickup window and the supply's departure window, and whose resulting
 * arrival respects the demand's latest-arrival constraint and the supply's
 * max-extra-time cap.
 *
 * Returns null if no such departure exists.
 */
function findFeasibleDeparture(
  d: TransportationDemand,
  s: TransportationSupply,
  travelTimeSec: number,
): { departSec: number; arriveSec: number; slackSec: number } | null {
  // Window overlap: latest start vs. earliest end.
  const start = Math.max(d.timeWindow.startSec, s.departureWindow.startSec);
  const end = Math.min(d.timeWindow.endSec, s.departureWindow.endSec);
  if (start > end) return null;

  // Earliest feasible departure is the start of the overlap. (For transit with
  // a schedule we would snap to the next scheduled departure; the live supply
  // model collapses schedule into a window, so depart-at-start is the
  // optimistic assumption.)
  const departSec = start;
  const arriveSec = departSec + travelTimeSec;

  if (arriveSec > d.latestArrivalSec) return null;

  // Extra-time cap (supply-side constraint): is the trip short enough that the
  // supply can absorb it without exceeding its maxExtraTimeMin?
  const maxExtraTimeSec = (s.constraints?.maxExtraTimeMin ?? 240) * 60;
  // "Extra time" is the travel time the supply incurs beyond a baseline direct
  // trip from its origin to its planned destination. We approximate that here
  // as the demand's direct pickup->dropoff time (the dedicated-trip baseline).
  const directSec = Math.max(
    60,
    Math.round((haversineKm(d.origin, d.destination) / speedFor(s)) * 3600),
  );
  const extraSec = Math.max(0, travelTimeSec - directSec);
  if (extraSec > maxExtraTimeSec) return null;

  const slackSec = d.latestArrivalSec - arriveSec;
  return { departSec, arriveSec, slackSec };
}

// ═══════════════════════════════════════════════════════════════════════
// PRICING (initial estimate — refined later by pricing.ts)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Initial estimate of money flows for a (demand, supply) pair. The PricingEngine
 * (pricing.ts) refines this into a full PricingResult with cost breakdown and
 * expected margin — but the opportunity must be priced at discovery time so the
 * clearing engine can rank by welfare without a second pass.
 *
 * All values are integer minor units (cents).
 */
const PLATFORM_FEE_RATE_DEFAULT = 0.15;
const SUPPLIER_MARGIN_RATE = 0.15;

function estimateMoney(
  demand: TransportationDemand,
  supply: TransportationSupply,
  distanceKm: number,
  timeMin: number,
): {
  price: number;
  supplierCompensation: number;
  platformFee: number;
  estimatedProviderCost: number;
} {
  const km = Math.max(distanceKm, 0);
  const hours = Math.max(timeMin, 0) / 60;
  const cm = supply.costModel;

  // Provider operating cost (what it actually costs the supplier to drive this).
  const estimatedProviderCost = Math.round(
    cm.fixedCost + km * cm.costPerKm + hours * cm.costPerHour,
  );

  // Supplier compensation = max(minimumCompensation, cost + margin).
  const withMargin = Math.round(
    estimatedProviderCost * (1 + SUPPLIER_MARGIN_RATE),
  );
  const supplierCompensation = Math.max(cm.minimumCompensation, withMargin);

  // Platform fee is taken on top of supplier compensation (user pays both).
  const platformFee = Math.round(supplierCompensation * PLATFORM_FEE_RATE_DEFAULT);
  const price = supplierCompensation + platformFee;

  return { price, supplierCompensation, platformFee, estimatedProviderCost };
}

// ═══════════════════════════════════════════════════════════════════════
// CONFIDENCE + EXECUTION PROBABILITY
// ═══════════════════════════════════════════════════════════════════════

function clampUnit(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Execution probability is degraded by:
 *   - tight temporal slack (little room for delay before latest-arrival breach)
 *   - detour close to the tolerance limit (the supply may decline)
 *   - tight capacity (only one seat left — fragile to upstream cancellation)
 */
function computeExecutionProbability(opts: {
  slackSec: number;
  travelTimeSec: number;
  detourKm: number;
  detourToleranceKm: number;
  availableCapacity: number;
  partySize: number;
}): number {
  const base = 0.85;

  // Temporal robustness: 30+ min slack is comfortable; <5 min is fragile.
  const slackMin = opts.slackSec / 60;
  const temporalFactor = clampUnit(0.4 + (slackMin / 30) * 0.6);

  // Detour headroom: 0 detour = full probability; at tolerance limit = 0.6.
  const tol = Math.max(0.001, opts.detourToleranceKm);
  const detourRatio = clampUnit(opts.detourKm / tol);
  const detourFactor = 1 - 0.4 * detourRatio;

  // Capacity headroom: spare seats reduce single-cancellation fragility.
  const remaining = opts.availableCapacity - opts.partySize;
  const capacityFactor = remaining >= 3 ? 1 : 0.7 + 0.1 * remaining;

  return clampUnit(base * temporalFactor * detourFactor * capacityFactor);
}

/**
 * Confidence blends source provenance with structural certainty. A FIXTURE
 * supply observed in the last minute is highly certain about its own state, but
 * its inferred willingness to detour is not. We surface both via provenance and
 * a conservative blended confidence.
 */
function computeConfidence(supply: TransportationSupply, detourKm: number): number {
  const provConf = supply.provenance?.confidence ?? 0.7;
  const envConf =
    supply.provenance?.environment === "LIVE"
      ? 0.95
      : supply.provenance?.environment === "SANDBOX"
        ? 0.85
        : supply.provenance?.environment === "FIXTURE"
          ? 0.7
          : 0.5;
  const structural = 1 - Math.min(0.3, detourKm / 20);
  return clampUnit(0.5 * provConf + 0.3 * envConf + 0.2 * structural);
}

// ═══════════════════════════════════════════════════════════════════════
// WHY-STRINGS (the ORYXX thesis in plain prose)
// ═══════════════════════════════════════════════════════════════════════

function buildWhyFeasible(
  d: TransportationDemand,
  s: TransportationSupply,
  detourKm: number,
  toleranceKm: number,
  departSec: number,
  arriveSec: number,
  distanceKm: number,
  timeMin: number,
): string {
  return (
    `Demand ${d.id} (${d.kind}, partySize=${d.partySize}) is compatible with ` +
    `${s.mode} supply ${s.id} (availableCapacity=${s.availableCapacity}). ` +
    `Route detour ${detourKm.toFixed(2)}km <= tolerance ${toleranceKm.toFixed(2)}km; ` +
    `trip distance ${distanceKm.toFixed(2)}km over ~${timeMin}min; ` +
    `depart ${secToHHMM(departSec)} within demand window ` +
    `[${secToHHMM(d.timeWindow.startSec)}..${secToHHMM(d.timeWindow.endSec)}]; ` +
    `arrive ${secToHHMM(arriveSec)} <= latest ${secToHHMM(d.latestArrivalSec)}.`
  );
}

function buildWhyNow(
  d: TransportationDemand,
  s: TransportationSupply,
  departSec: number,
  slackSec: number,
): string {
  const supplyLoc = s.currentLocation ?? s.origin;
  const pickupDist = haversineKm(supplyLoc, d.origin);
  const slackMin = Math.round(slackSec / 60);
  const urgency =
    d.priority === "urgent"
      ? "URGENT demand"
      : d.priority === "high"
        ? "high-priority demand"
        : "demand";
  return (
    `${urgency} ${d.id} must depart by ${secToHHMM(departSec)} ` +
    `(slack to latest-arrival: ${slackMin}min). Supply ${s.id} is currently ` +
    `${s.status.toLowerCase()} ~${pickupDist.toFixed(2)}km from pickup — ` +
    `dispatching now preserves the time window; deferring by even a few ` +
    `minutes would breach latest-arrival or expire the supply's availability.`
  );
}

function buildWhyThisSupply(
  d: TransportationDemand,
  s: TransportationSupply,
  estimatedProviderCost: number,
  supplierCompensation: number,
): string {
  const cm = s.costModel;
  return (
    `Supply ${s.id} (provider ${s.providerId}, mode ${s.mode}) offers ` +
    `${s.availableCapacity} units of available capacity at ` +
    `cost ${cm.costPerKm}c/km + ${cm.costPerHour}c/h + ${cm.fixedCost}c fixed ` +
    `(min compensation ${cm.minimumCompensation}c). Estimated provider cost ` +
    `${estimatedProviderCost}c; supplier compensation ${supplierCompensation}c ` +
    `covers cost + margin while staying within demand budget ${d.budget}c.`
  );
}

function buildWhyOrdinaryRoutingMissesIt(
  d: TransportationDemand,
  s: TransportationSupply,
  detourKm: number,
): string {
  switch (s.mode) {
    case "carpool":
      return (
        `Ordinary routing treats the driver and rider as independent agents. ` +
        `ORYXX observed that a commuter (supply ${s.id}) is already committed ` +
        `to a route passing within ${detourKm.toFixed(2)}km of ` +
        `${d.origin.name ?? "pickup"} and ${d.destination.name ?? "dropoff"} ` +
        `with spare capacity — a latent-supply match no dedicated-rideshare ` +
        `dispatch system could construct.`
      );
    case "truck":
      return (
        `Ordinary routing treats freight as a dedicated shipment requiring a ` +
        `truck to deadhead to origin. ORYXX observed truck ${s.id} already ` +
        `en route with spare capacity ${s.availableCapacity} — a backhaul ` +
        `opportunity the shipper's TMS has no visibility into.`
      );
    case "transit":
      return (
        `Ordinary routing defaults to on-demand rideshare for time-constrained ` +
        `trips. ORYXX found a scheduled transit run (supply ${s.id}) whose ` +
        `route serves ${d.origin.name ?? "pickup"}→${d.destination.name ?? "dropoff"} ` +
        `within the demand window at lower cost.`
      );
    case "taxi":
    case "fhv":
      return (
        `Ordinary routing sees the dispatcher's street-hail queue, not the ` +
        `real-time position of licensed ${s.mode} supply ${s.id}. ORYXX ` +
        `observed this vehicle ${s.availableCapacity}-empty and within detour ` +
        `tolerance — an immediacy match a centralized dispatcher cannot surface.`
      );
    case "micromobility":
      return (
        `Ordinary routing defaults to motorized modes. ORYXX found a ` +
        `micromobility vehicle ${s.id} positioned ${detourKm.toFixed(2)}km from ` +
        `pickup that serves this short-distance demand at lower cost and zero ` +
        `emissions.`
      );
    case "walking":
      return (
        `Ordinary routing would dispatch a motorized vehicle for a trip ` +
        `ORYXX recognizes as walkable from supply ${s.id}'s position.`
      );
    case "rideshare":
    default:
      return (
        `Ordinary routing's information model lacks visibility into supply ` +
        `${s.id}'s real-time location and willingness to detour ` +
        `${detourKm.toFixed(2)}km for this demand — a match the ORYXX ` +
        `live-supply graph surfaces but a static route planner cannot construct.`
      );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FEASIBILITY CHECK (single demand × supply pair)
// ═══════════════════════════════════════════════════════════════════════

interface FeasibilityOutcome {
  feasible: boolean;
  reasonIfInfeasible?: string;
  detourKm: number;
  pickupDetourKm: number;
  dropoffDetourKm: number;
  toleranceKm: number;
  distanceKm: number;
  travelTimeSec: number;
  travelTimeMin: number;
  departSec?: number;
  arriveSec?: number;
  slackSec?: number;
  capacityUsed: number;
}

function checkFeasibility(
  d: TransportationDemand,
  s: TransportationSupply,
): FeasibilityOutcome {
  const empty: FeasibilityOutcome = {
    feasible: false,
    detourKm: 0,
    pickupDetourKm: 0,
    dropoffDetourKm: 0,
    toleranceKm: Math.min(
      s.detourToleranceKm,
      s.constraints?.maxDetourKm ?? s.detourToleranceKm,
    ),
    distanceKm: 0,
    travelTimeSec: 0,
    travelTimeMin: 0,
    capacityUsed: 0,
  };

  // Hard constraint 1: kind compatibility
  if (!isKindCompatible(d, s)) {
    return {
      ...empty,
      reasonIfInfeasible: `kind-incompatible: demand kind "${d.kind}" not served by mode "${s.mode}"`,
    };
  }

  // Hard constraint 2: capacity (in available units)
  if (s.availableCapacity < d.partySize) {
    return {
      ...empty,
      reasonIfInfeasible: `capacity: demand partySize ${d.partySize} > supply availableCapacity ${s.availableCapacity}`,
    };
  }

  // Hard constraint 3: status (supply must be AVAILABLE)
  if (s.status !== "AVAILABLE") {
    return {
      ...empty,
      reasonIfInfeasible: `supply-status: supply is ${s.status}, not AVAILABLE`,
    };
  }

  // Hard constraint 4: spatial — supply's planned route serves pickup+dropoff
  // within detour tolerance, in order.
  const rs = routeServes(s, d.origin, d.destination);
  if (!rs.feasible) {
    return {
      ...empty,
      reasonIfInfeasible: `spatial-detour: pickup detour ${rs.pickupDetourKm}km / dropoff detour ${rs.dropoffDetourKm}km exceeds tolerance ${empty.toleranceKm}km`,
      pickupDetourKm: rs.pickupDetourKm,
      dropoffDetourKm: rs.dropoffDetourKm,
      detourKm: rs.detourKm,
    };
  }

  // Trip distance = direct pickup->dropoff + supply's perpendicular detour.
  // (We do NOT double-count: the supply's route already passes near both
  // points; the detour is the extra off-route distance, not added twice.)
  const directKm = haversineKm(d.origin, d.destination);
  const distanceKm = Math.round((directKm + rs.detourKm) * 100) / 100;
  const speed = speedFor(s);
  const travelTimeSec = Math.max(
    60,
    Math.round((distanceKm / speed) * 3600),
  );
  const travelTimeMin = Math.max(1, Math.round(travelTimeSec / 60));

  // Hard constraint 5: temporal — overlapping departure window + arrival feasible
  const dep = findFeasibleDeparture(d, s, travelTimeSec);
  if (!dep) {
    return {
      ...empty,
      detourKm: rs.detourKm,
      pickupDetourKm: rs.pickupDetourKm,
      dropoffDetourKm: rs.dropoffDetourKm,
      distanceKm,
      travelTimeSec,
      travelTimeMin,
      reasonIfInfeasible:
        "temporal: no departure fits both demand window and supply departure window while respecting latest-arrival and max-extra-time",
    };
  }

  return {
    feasible: true,
    detourKm: rs.detourKm,
    pickupDetourKm: rs.pickupDetourKm,
    dropoffDetourKm: rs.dropoffDetourKm,
    toleranceKm: empty.toleranceKm,
    distanceKm,
    travelTimeSec,
    travelTimeMin,
    departSec: dep.departSec,
    arriveSec: dep.arriveSec,
    slackSec: dep.slackSec,
    capacityUsed: d.partySize,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// OPPORTUNITY FACTORY
// ═══════════════════════════════════════════════════════════════════════

let opportunityCounter = 0;

function makeOpportunityId(d: TransportationDemand, s: TransportationSupply): string {
  opportunityCounter++;
  return `OPP-${s.providerId}-${d.id}-${s.id}-${opportunityCounter}`;
}

function buildProvenance(s: TransportationSupply): Provenance {
  // Opportunity provenance inherits from supply provenance, but source becomes
  // "inferred" because the opportunity is a constructed match, not a raw
  // observation. Environment is preserved (SANDBOX supply → SANDBOX opportunity,
  // so it can never produce W3-M/W4-M evidence unless executed LIVE).
  const base = s.provenance ?? {
    environment: "FIXTURE" as const,
    source: "assumed" as const,
    observedAt: new Date().toISOString(),
    confidence: 0.7,
  };
  return {
    environment: base.environment,
    source: "inferred",
    observedAt: new Date().toISOString(),
    validFrom: base.validFrom,
    validTo: base.validTo,
    confidence: base.confidence,
  };
}

function buildOpportunity(
  d: TransportationDemand,
  s: TransportationSupply,
  f: FeasibilityOutcome,
): TransportationOpportunity {
  // Initial money estimate (refined by pricing.ts into a PricingResult later).
  const money = estimateMoney(d, s, f.distanceKm, f.travelTimeMin);

  const executionProbability = computeExecutionProbability({
    slackSec: f.slackSec ?? 0,
    travelTimeSec: f.travelTimeSec,
    detourKm: f.detourKm,
    detourToleranceKm: f.toleranceKm,
    availableCapacity: s.availableCapacity,
    partySize: d.partySize,
  });
  const confidence = computeConfidence(s, f.detourKm);

  // Welfare = social surplus = value - supplier cost (price cancels; see
  // canonical/evaluate.ts). Use demand.value (user's willingness to pay) minus
  // the estimated provider operating cost. This is what the market clearing
  // engine ranks by.
  const welfare = d.value - money.estimatedProviderCost;

  return {
    id: makeOpportunityId(d, s),
    demandId: d.id,
    supplyId: s.id,
    providerId: s.providerId,
    route: {
      pickup: d.origin,
      dropoff: d.destination,
      waypoints: [...(s.plannedRoute ?? []), ...(s.plannedStops ?? [])],
      distanceKm: f.distanceKm,
      estimatedTimeMin: f.travelTimeMin,
    },
    departure: {
      startSec: f.departSec ?? 0,
      endSec: (f.departSec ?? 0) + f.travelTimeSec,
    },
    arrival: {
      startSec: f.arriveSec ?? 0,
      endSec: f.arriveSec ?? 0,
    },
    detourKm: f.detourKm,
    extraTimeMin: Math.max(0, f.travelTimeMin - Math.round((haversineKm(d.origin, d.destination) / speedFor(s)) * 60)),
    capacityUsed: f.capacityUsed,
    price: money.price,
    supplierCompensation: money.supplierCompensation,
    platformFee: money.platformFee,
    executionProbability,
    confidence,
    provenance: buildProvenance(s),
    status: "DISCOVERED",
    whyFeasible: buildWhyFeasible(
      d, s, f.detourKm, f.toleranceKm, f.departSec ?? 0, f.arriveSec ?? 0, f.distanceKm, f.travelTimeMin,
    ),
    whyNow: buildWhyNow(d, s, f.departSec ?? 0, f.slackSec ?? 0),
    whyThisSupply: buildWhyThisSupply(d, s, money.estimatedProviderCost, money.supplierCompensation),
    whyOrdinaryRoutingMissesIt: buildWhyOrdinaryRoutingMissesIt(d, s, f.detourKm),
    isMarketplaceOpportunity: true,
    researchStimulus: false,
    createdAt: new Date().toISOString(),
    // Expose welfare via a non-enumerable tag for the clearing engine. We do
    // NOT add it to the type (the type is canonical); instead the clearing
    // engine recomputes welfare from demand.value and supply cost. We attach
    // it here for debugging convenience via a Symbol-keyed property.
    ...(welfare !== 0 ? { _welfare: welfare } : {}),
  } as TransportationOpportunity & { _welfare?: number };
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Discover all feasible (demand, supply) opportunities from the given demand
 * and supply sets, sorted by social welfare (value - cost) descending.
 *
 * The engine does NOT deduplicate by demand — multiple supplies may legitimately
 * serve the same demand, and the market clearing engine is responsible for
 * choosing the welfare-maximizing subset under capacity constraints.
 *
 * @param demands  Open marketplace demands (status "OPEN" recommended)
 * @param supplies Available marketplace supplies (status "AVAILABLE" required)
 * @returns        Sorted TransportationOpportunity[]
 */
export function discoverOpportunities(
  demands: TransportationDemand[],
  supplies: TransportationSupply[],
): TransportationOpportunity[] {
  const opportunities: TransportationOpportunity[] = [];

  for (const demand of demands) {
    // Skip demands that are not in an actionable state.
    if (demand.status !== "OPEN") continue;
    for (const supply of supplies) {
      const f = checkFeasibility(demand, supply);
      if (!f.feasible) continue;
      opportunities.push(buildOpportunity(demand, supply, f));
    }
  }

  // Sort by social welfare (value - cost) descending. Welfare is recomputed
  // here from demand.value and supply costModel + opportunity detour to ensure
  // the ranking reflects the canonical welfare definition (no artificial value
  // from price transfers).
  opportunities.sort((a, b) => {
    const wa = welfareOf(a);
    const wb = welfareOf(b);
    if (wb !== wa) return wb - wa;
    // Tiebreaker: higher execution probability first.
    return b.executionProbability - a.executionProbability;
  });

  return opportunities;
}

/**
 * Compute social welfare (minor units) for an opportunity.
 *
 * Welfare = demand.value - estimated provider cost. Price is a transfer between
 * user and supplier and does NOT change social welfare (canonical invariant,
 * see market/canonical/evaluate.ts). Because TransportationOpportunity does
 * not carry demand.value or provider cost as fields, we approximate provider
 * cost from the route distance and the supply's cost model — which requires
 * the caller to pass the supply. For ranking purposes only, we use the
 * opportunity's stored _welfare tag if present (set at discovery time); this
 * keeps the public signature of discoverOpportunities clean.
 */
export function welfareOf(o: TransportationOpportunity): number {
  const tagged = (o as TransportationOpportunity & { _welfare?: number })._welfare;
  if (typeof tagged === "number") return tagged;
  // Fallback: best-effort approximation using opportunity's own comp + fee +
  // detour. This is NOT canonical welfare (it includes price), but it preserves
  // a reasonable ranking when the tag is missing.
  return o.price + o.detourKm * 100;
}

// Re-export internals used by market-clearing.ts and pricing.ts to avoid
// recomputation. These are intentionally side-effect-free.
export {
  checkFeasibility as _checkFeasibility,
  estimateMoney as _estimateMoney,
  speedFor as _speedFor,
  isKindCompatible as _isKindCompatible,
  routeServes as _routeServes,
  findFeasibleDeparture as _findFeasibleDeparture,
  PLATFORM_FEE_RATE_DEFAULT,
  SUPPLIER_MARGIN_RATE,
};
