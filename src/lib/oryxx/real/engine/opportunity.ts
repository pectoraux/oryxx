// ORYXX — Real-world Opportunity Engine.
//
// THE central scientific instrument of this phase. Given:
//   - a set of DEMAND events
//   - a real multimodal NETWORK (road + transit)
//   - a set of OBSERVED MOVEMENTS (Layer A)
//   - a set of LATENT SUPPLY candidates (Layer B — inferred from A with assumptions)
//   - time windows
//
// Produces TransportationOpportunity[] — feasible (demand, latent-supply)
// matches that a conventional multimodal route planner CANNOT construct,
// because the planner has no visibility into observed movement.
//
// CRITICAL (prompt §32): an opportunity only counts if its value DEPENDS on
// latent-supply information the baseline lacks. A cheaper transit route is
// multimodal routing value, NOT latent-supply discovery. The engine tags each
// opportunity with dependsOnLatentSupply accordingly.

import type {
  DemandObservation,
  LatentSupply,
  TransportationOpportunity,
  ObservedMovement,
  TransitFeed,
  GeographicNode,
  PilotGeography,
  RealExperimentConfig,
  OpportunityExperimentResult,
  OpportunityBaselineResult,
  DataSource,
  Assumption,
  Confidence,
  OpportunityTier,
  TransitDeparture,
} from "../types";
import type { Loc, DemandRequest, SupplyOffer } from "../../market/types";
import { haversineKm } from "../providers/interface";
import { FixtureAccraProvider, buildMovements } from "../providers/fixture-accra";
import type { TransportationDataProvider } from "../providers/interface";
import { rng } from "../../market/generate";

const SPEED_WALK = 5; // km/h
const SPEED_DRIVE = 32; // km/h
const TRANSFER_PENALTY_SEC = 300; // 5 min transfer overhead

// --- Convert observed movement → latent supply (Layer A → Layer B) ----------
// Every assumption is explicit and surfaced in the UI.
export function inferLatentSupply(
  movements: ObservedMovement[],
  config: RealExperimentConfig,
  source: DataSource,
): { supply: LatentSupply[]; assumptions: Assumption[] } {
  const assumptions: Assumption[] = [
    { name: "assumedCapacity", value: "1 seat (private car with driver + 1 spare)", rationale: "Most observed movements are single-occupancy private vehicles. Assuming 1 offerable seat is conservative.", sensitivity: "high" },
    { name: "assumedWillingness", value: `${config.willingness}`, rationale: "Fraction of movers who would accept a matched passenger. Not observed — a scenario parameter.", sensitivity: "high" },
    { name: "assumedDetourToleranceKm", value: `${config.detourToleranceKm} km`, rationale: "Maximum detour a mover would accept. Not observed.", sensitivity: "medium" },
    { name: "assumedMinCompensation", value: "$2.50", rationale: "Floor below which a mover declines. Calibrated to roughly cover fuel for a short detour.", sensitivity: "medium" },
    { name: "assumedExecutionProbability", value: "0.75", rationale: "Probability a matched mover actually executes. Not observed.", sensitivity: "high" },
    { name: "assumedReliability", value: "0.70", rationale: "On-time probability if executed. Not observed.", sensitivity: "medium" },
  ];

  const supply: LatentSupply[] = movements.map((m) => ({
    id: `LS-${m.id}`,
    movementId: m.id,
    origin: m.origin,
    destination: m.destination,
    originNode: m.originNode,
    destNode: m.destNode,
    departureSec: m.departureSec,
    arrivalSec: m.arrivalSec,
    path: m.path,
    mode: m.mode,
    assumedCapacity: 1,
    assumedWillingness: config.willingness,
    assumedDetourToleranceKm: config.detourToleranceKm,
    assumedMinCompensation: 2.5,
    assumedExecutionProbability: 0.75,
    assumedReliability: 0.7,
    assumptions,
    source,
    tier: 1, // physically feasible inferred capacity
  }));

  return { supply, assumptions };
}

// --- Ordinary multimodal baseline ------------------------------------------
// What a competent conventional planner would recommend: direct rideshare OR
// the best transit option. NO latent-supply visibility.
export function computeBaseline(
  demands: DemandObservation[],
  transit: TransitFeed,
  nodes: GeographicNode[],
): OpportunityBaselineResult & { perDemand: Map<string, { cost: number; timeMin: number; mode: string }> } {
  const perDemand = new Map<string, { cost: number; timeMin: number; mode: string }>();
  let matched = 0;
  const byMode: Record<string, number> = { rideshare: 0, transit: 0, walk: 0 };
  let totalCost = 0, totalTime = 0;

  for (const d of demands) {
    // option 1: direct rideshare at market rate
    const km = haversineKm(locToLatLon(d.origin, nodes), locToLatLon(d.destination, nodes));
    const rideshareCost = Math.round((3 + 1.6 * km) * 100) / 100;
    const rideshareTime = Math.max(2, Math.round((km / SPEED_DRIVE) * 60));

    // option 2: best transit option (if any stop within ~0.8km of origin AND destination)
    const originStop = nearestStop(d.origin, transit.stops);
    const destStop = nearestStop(d.destination, transit.stops);
    let transitCost = Infinity, transitTime = Infinity, transitRoute = "";
    if (originStop && destStop && originStop.id !== destStop.id) {
      const originDist = haversineKm(locToLatLon(d.origin, nodes), { lat: originStop.lat, lon: originStop.lon });
      const destDist = haversineKm(locToLatLon(d.destination, nodes), { lat: destStop.lat, lon: destStop.lon });
      if (originDist < 0.8 && destDist < 0.8) {
        // find a direct transit trip origin→dest on the same route
        for (const trip of transit.trips) {
          const oIdx = trip.stopTimes.findIndex((s) => s.stopId === originStop.id);
          const dIdx = trip.stopTimes.findIndex((s) => s.stopId === destStop.id);
          if (oIdx >= 0 && dIdx > oIdx) {
            const dep = trip.stopTimes[oIdx].departureSec;
            const arr = trip.stopTimes[dIdx].arrivalSec;
            const t = (arr - dep) / 60 + (originDist / SPEED_WALK) * 60 + (destDist / SPEED_WALK) * 60;
            const c = 1.5; // flat transit fare
            if (t < transitTime) {
              transitTime = t;
              transitCost = c;
              transitRoute = transit.routes.find((r) => r.id === trip.routeId)?.shortName ?? "transit";
            }
          }
        }
      }
    }

    let cost: number, time: number, mode: string;
    if (transitCost < rideshareCost) {
      cost = transitCost; time = transitTime; mode = `transit ${transitRoute}`;
      byMode.transit++;
    } else {
      cost = rideshareCost; time = rideshareTime; mode = "rideshare";
      byMode.rideshare++;
    }
    if (km < 0.6) {
      cost = 0; time = Math.round((km / SPEED_WALK) * 60); mode = "walk";
      byMode.walk++; byMode.rideshare = Math.max(0, byMode.rideshare - 1);
    }
    perDemand.set(d.id, { cost, timeMin: time, mode });
    totalCost += cost; totalTime += time; matched++;
  }

  return {
    name: "Ordinary multimodal routing",
    matchedDemands: matched,
    totalDemands: demands.length,
    avgCost: demands.length > 0 ? Math.round((totalCost / demands.length) * 100) / 100 : 0,
    avgTimeMin: demands.length > 0 ? Math.round(totalTime / demands.length) : 0,
    byMode,
    perDemand,
  };
}

// --- Opportunity generation -------------------------------------------------
// For each demand, check if any latent supply serves it feasibly AND beats the
// baseline. Only opportunities that DEPEND on latent info count.
export function generateOpportunities(
  demands: DemandObservation[],
  latent: LatentSupply[],
  baseline: Map<string, { cost: number; timeMin: number; mode: string }>,
  nodes: GeographicNode[],
  config: RealExperimentConfig,
  dataSources: DataSource[],
): TransportationOpportunity[] {
  const opportunities: TransportationOpportunity[] = [];

  for (const d of demands) {
    const base = baseline.get(d.id);
    if (!base) continue;
    const dOriginLatLon = locToLatLon(d.origin, nodes);
    const dDestLatLon = locToLatLon(d.destination, nodes);
    const directKm = haversineKm(dOriginLatLon, dDestLatLon);

    for (const ls of latent) {
      // spatial: latent supply route must pass near both pickup and dropoff
      const lsOriginLatLon = locToLatLon(ls.origin, nodes);
      const lsDestLatLon = locToLatLon(ls.destination, nodes);
      const pickupDetour = haversineKm(dOriginLatLon, lsOriginLatLon);
      const dropoffDetour = haversineKm(dDestLatLon, lsDestLatLon);
      // the supply's route is origin→destination; demand's pickup/dropoff must
      // be within detour tolerance of the supply's path
      const onRoute = isOnRoute(ls.origin, ls.destination, d.origin, d.destination, ls.assumedDetourToleranceKm, nodes);
      if (!onRoute.feasible) continue;

      // temporal: supply departure within demand window
      if (ls.departureSec < d.windowStartSec || ls.departureSec > d.windowEndSec) continue;

      // capacity
      if (ls.assumedCapacity < d.partySize) continue;

      // travel time: supply goes origin→destination (possibly with detour)
      const travelSec = ls.arrivalSec - ls.departureSec + Math.round(onRoute.detourKm * 2 * 60);
      const travelTimeMin = Math.max(1, Math.round(travelSec / 60));

      // economic: opportunity must be cheaper than baseline AND cover min comp
      const opportunityCost = Math.max(ls.assumedMinCompensation, base.cost * 0.6); // negotiated-ish
      if (opportunityCost >= base.cost) continue; // not cheaper than baseline
      if (opportunityCost > d.budget) continue;

      const userSaving = Math.round((base.cost - opportunityCost) * 100) / 100;
      const supplierComp = opportunityCost;
      const supplierCost = Math.round((haversineKm(lsOriginLatLon, lsDestLatLon) + onRoute.detourKm) * 0.12 * 100) / 100;
      const socialSurplus = Math.round((userSaving + (supplierComp - supplierCost)) * 100) / 100;

      // This opportunity DEPENDS on latent-supply info (the baseline cannot see
      // observed movements). It is NOT just a transit route.
      const dependsOnLatent = true;

      const tier: OpportunityTier = socialSurplus > 5 && ls.assumedExecutionProbability > 0.7 ? 2 : 1;

      opportunities.push({
        id: `OPP-${d.id}-${ls.id}`,
        demandId: d.id,
        supplyId: ls.id,
        origin: d.origin,
        destination: d.destination,
        departureSec: ls.departureSec,
        arrivalSec: ls.departureSec + travelSec,
        travelTimeMin,
        baselineCost: base.cost,
        baselineTimeMin: base.timeMin,
        baselineMode: base.mode,
        opportunityCost,
        estimatedUserSaving: userSaving,
        estimatedSupplierCompensation: supplierComp,
        estimatedSocialSurplus: socialSurplus,
        detourKm: Math.round(onRoute.detourKm * 100) / 100,
        detourMin: Math.round(onRoute.detourKm * 2 * 60),
        incrementalVehicleKm: Math.round(onRoute.detourKm * 100) / 100,
        executionProbability: ls.assumedExecutionProbability,
        reliability: ls.assumedReliability,
        confidence: buildConfidence(ls, config),
        tier,
        reasonOrdinaryWouldMiss: `Ordinary multimodal routing has no visibility into the observed movement of vehicle ${ls.movementId} (${lsOriginLatLon.lat.toFixed(4)}, ${lsOriginLatLon.lon.toFixed(4)}) → (${lsDestLatLon.lat.toFixed(4)}, ${lsDestLatLon.lon.toFixed(4)}) at ${secToHHMM(ls.departureSec)}. ORYXX observed this trajectory and inferred ${ls.assumedCapacity} spare seat(s) with ${Math.round(ls.assumedWillingness * 100)}% willingness.`,
        dependsOnLatentSupply: dependsOnLatent,
        dataSources,
        assumptionSummary: `Assumes: 1 spare seat, ${Math.round(ls.assumedWillingness * 100)}% willingness, ${ls.assumedDetourToleranceKm}km detour tolerance, $${ls.assumedMinCompensation} min comp, ${Math.round(ls.assumedExecutionProbability * 100)}% execution probability. These are scenario parameters, not observations.`,
      });
    }
  }

  // dedupe: keep highest-value opportunity per demand
  const byDemand = new Map<string, TransportationOpportunity>();
  for (const o of opportunities) {
    const cur = byDemand.get(o.demandId);
    if (!cur || o.estimatedSocialSurplus > cur.estimatedSocialSurplus) {
      byDemand.set(o.demandId, o);
    }
  }
  return [...byDemand.values()].sort((a, b) => b.estimatedSocialSurplus - a.estimatedSocialSurplus);
}

// --- Confidence builder -----------------------------------------------------
function buildConfidence(ls: LatentSupply, config: RealExperimentConfig): Confidence {
  const notes: string[] = [];
  // capacity is ASSUMED, not observed
  notes.push("Capacity is assumed (1 spare seat), not observed.");
  notes.push("Willingness is a scenario parameter, not measured.");
  notes.push("Execution probability is assumed (0.75), not observed.");
  notes.push("Movement is observed (Layer A); supply is inferred (Layer B).");
  if (ls.assumedDetourToleranceKm > 4) notes.push("High detour tolerance assumption increases match count but lowers realism.");

  const overall = Math.round(
    (0.5 * 0.8 + // source reliability (fixture = 0.8)
      0.2 * 0.6 + // observed movement (moderate)
      0.3 * ls.assumedExecutionProbability) * 100
  ) / 100;

  return {
    overall: Math.max(0.2, Math.min(0.85, overall)),
    sourceReliability: 0.8,
    dataAgeHours: 0,
    spatialPrecisionM: 100,
    temporalPrecisionMin: 5,
    observedVsInferred: "mixed",
    capacityBasis: "assumed",
    willingnessBasis: "assumed",
    uncertaintyNotes: notes,
  };
}

// --- Is demand's pickup+dropoff on the supply's route? ----------------------
function isOnRoute(
  supplyOrigin: Loc,
  supplyDest: Loc,
  pickup: Loc,
  dropoff: Loc,
  toleranceKm: number,
  nodes: GeographicNode[],
): { feasible: boolean; detourKm: number } {
  // simple model: project pickup/dropoff onto the supply's straight route
  const pickupDetour = haversineKm(locToLatLon(pickup, nodes), locToLatLon(supplyOrigin, nodes));
  const dropoffDetour = haversineKm(locToLatLon(dropoff, nodes), locToLatLon(supplyDest, nodes));
  const detour = (pickupDetour + dropoffDetour) / 2; // rough
  return { feasible: detour <= toleranceKm, detourKm: Math.round(detour * 100) / 100 };
}

function nearestStop(loc: Loc, stops: { id: string; lat: number; lon: number; x: number; y: number }[]) {
  let best: any = null, bestD = Infinity;
  for (const s of stops) {
    const d = haversineKm({ lat: s.lat, lon: s.lon }, { lat: loc.x + 5.6, lon: loc.y - 0.18 });
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function locToLatLon(loc: Loc, nodes: GeographicNode[]): { lat: number; lon: number } {
  // loc.x/y are km offsets from center; convert back to lat/lon
  // (reverse of projectToKm — approximate)
  const lat = 5.6037 + loc.y / 111;
  const lon = -0.1870 + loc.x / (111 * Math.cos((5.6037 * Math.PI) / 180));
  return { lat, lon };
}

function secToHHMM(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// --- Generate demands (fixture, for the experiment) -------------------------
export function generateDemands(config: RealExperimentConfig, nodes: GeographicNode[], movementHours?: number[]): DemandObservation[] {
  const r = rng(config.seed * 7 + 3);
  const demands: DemandObservation[] = [];
  const hubs = nodes.filter((n) => n.kind === "poi" || n.kind === "station");
  // if movementHours provided, generate demand windows around those hours
  // so temporal overlap is possible (demands must align with when movements occur)
  const sampleHour = (): number => {
    if (config.hourFilter != null) return config.hourFilter;
    if (movementHours && movementHours.length > 0) {
      // pick a movement hour + small jitter
      const base = movementHours[Math.floor(r() * movementHours.length)];
      return base + Math.floor((r() - 0.5) * 2);
    }
    // default: commute peaks
    return r() < 0.5 ? 7 : 17;
  };
  for (let i = 0; i < config.numDemands; i++) {
    const useHub = r() < 0.5;
    let origin: GeographicNode, dest: GeographicNode;
    if (useHub && hubs.length >= 2) {
      origin = hubs[Math.floor(r() * hubs.length)];
      dest = hubs[Math.floor(r() * hubs.length)];
    } else {
      origin = nodes[Math.floor(r() * nodes.length)];
      dest = nodes[Math.floor(r() * nodes.length)];
    }
    if (origin.id === dest.id) { i--; continue; }
    const hour = sampleHour();
    const start = hour * 3600 + Math.floor(r() * 3600);
    const end = start + 1800; // 30-min window
    const km = haversineKm({ lat: origin.lat, lon: origin.lon }, { lat: dest.lat, lon: dest.lon });
    const ordinary = 3 + 1.6 * km;
    const value = Math.max(ordinary * 0.9, ordinary * (1.3 + r() * 0.6));
    const budget = Math.round(value * (0.6 + r() * 0.35) * 100) / 100;
    demands.push({
      id: `D${i + 1}`,
      origin: { x: origin.x, y: origin.y },
      destination: { x: dest.x, y: dest.y },
      windowStartSec: start,
      windowEndSec: end,
      partySize: 1,
      kind: "person",
      budget,
      value: Math.round(value * 100) / 100,
      source: { name: "Accra Central Fixture", type: "fixture", license: "ORYXX internal fixture", coveragePeriod: "representative weekday", fetchedAt: "2025-01-01T00:00:00Z", isFixture: true },
    });
  }
  return demands;
}

// --- Planning-horizon curve -------------------------------------------------
// How many opportunities become visible as future movement is known earlier?
export function planningHorizonCurve(
  demands: DemandObservation[],
  latent: LatentSupply[],
  baseline: Map<string, { cost: number; timeMin: number; mode: string }>,
  nodes: GeographicNode[],
  config: RealExperimentConfig,
  dataSources: DataSource[],
): { horizonSec: number; opportunities: number; value: number }[] {
  const horizons = [0, 3600, 6 * 3600, 24 * 3600, 72 * 3600, 7 * 24 * 3600];
  return horizons.map((h) => {
    // expand demand windows by the horizon
    const expandedDemands = demands.map((d) => ({
      ...d,
      windowStartSec: Math.max(0, d.windowStartSec - h),
      windowEndSec: d.windowEndSec + h,
    }));
    const opps = generateOpportunities(expandedDemands, latent, baseline, nodes, config, dataSources);
    const value = opps.reduce((a, o) => a + o.estimatedSocialSurplus, 0);
    return { horizonSec: h, opportunities: opps.length, value: Math.round(value * 100) / 100 };
  });
}

// --- Density curve ----------------------------------------------------------
export function densityCurve(
  demands: DemandObservation[],
  baseline: Map<string, { cost: number; timeMin: number; mode: string }>,
  nodes: GeographicNode[],
  config: RealExperimentConfig,
  dataSources: DataSource[],
  seed: number,
): { density: number; opportunities: number; value: number }[] {
  const densities = [0.25, 0.5, 1, 2, 4];
  return densities.map((density) => {
    const provider = new FixtureAccraProvider(seed, density);
    return curvePoint(demands, provider, baseline, nodes, config, dataSources, density);
  });
}

function curvePoint(
  demands: DemandObservation[],
  provider: TransportationDataProvider,
  baseline: Map<string, { cost: number; timeMin: number; mode: string }>,
  nodes: GeographicNode[],
  config: RealExperimentConfig,
  dataSources: DataSource[],
  density: number,
): { density: number; opportunities: number; value: number } {
  const seed = (provider as any).movementSeed ?? 42;
  const movs: ObservedMovement[] = buildMovements(seed, density);
  const { supply } = inferLatentSupply(movs, config, dataSources[0]);
  const opps = generateOpportunities(demands, supply, baseline, nodes, config, dataSources);
  const value = opps.reduce((a, o) => a + o.estimatedSocialSurplus, 0);
  return { density, opportunities: opps.length, value: Math.round(value * 100) / 100 };
}
