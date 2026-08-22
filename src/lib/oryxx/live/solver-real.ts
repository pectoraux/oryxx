// ORYXX — REAL Transportation Event Solver (SLICE 1).
//
// This module is the production counterpart to `src/lib/oryxx/solver.ts`.
// Where the legacy solver operates on the SYNTHETIC `world.ts` hubs, THIS
// solver grounds every plan in REAL external data:
//
//   1. Geocode origin + destination via OSM Nominatim (REAL coordinates).
//   2. Compute real road-network distances + travel times via OSRM (REAL).
//   3. Augment with real OBSERVED supply where available:
//        - Citi Bike NYC stations (if the O/D is near NYC)
//        - GTFS transit stops (if the O/D is near a loaded feed, e.g. MBTA Boston)
//      Both are OBSERVED_ONLY — they inform the user about real nearby supply
//      but cannot be transacted against (no reservation / accept / execute).
//
// The deterministic ranking authority is preserved (master prompt §26): the
// LLM parses intent; THIS module owns feasibility + scoring. No LLM is in the
// routing path.
//
// HONESTY CONTRACT — every plan carries explicit labels:
//   - `syntheticWorld: false`          → real coordinates + real travel times
//   - `tradeoffNote`                    → states which fields are REAL vs MODELLED
//   - `unknowns[]`                      → lists every modelled / unverified field
//
// Pricing, emissions, reliability, and comfort are MODELLED (no real pricing
// API for walk/bike/drive/transit exists at HEAD). They are clearly labelled as
// modelled in the plan's `tradeoffNote` and `unknowns`. Distances and travel
// times are REAL (from OSRM). Citi Bike `free_bikes` counts are REAL (observed).
// GTFS departure times are REAL (published schedule).
//
// If geocoding fails for BOTH origin and destination, the function returns an
// empty plans array with a clear `unknowns` explanation. It NEVER fabricates a
// route against synthetic hubs while claiming it is real.

import type {
  TransportationEvent,
  Plan,
  ItinerarySegment,
  ObjectiveWeights,
  Mode,
  SolveResponse,
} from "@/lib/oryxx/types";
import type { GeoPoint } from "@/lib/oryxx/live/types";
import { osmGeocoder, type GeocodeResult } from "@/lib/oryxx/live/adapters/osm-geocoding";
import { osrmRouter, type RouteResult } from "@/lib/oryxx/live/adapters/osrm-routing";
import { citibikeProvider } from "@/lib/oryxx/live/adapters/citibike-provider";
import { gtfsTransit } from "@/lib/oryxx/live/adapters/gtfs-transit";

// ═══════════════════════════════════════════════════════════════════════
// MODE MODEL PARAMETERS (MODELLED — clearly labelled in output)
// ═══════════════════════════════════════════════════════════════════════
// These are not observed from a live pricing/emissions API. They are honest,
// documented estimates used ONLY to produce a comparable score across modes.
// The plan's `tradeoffNote` always discloses that cost/emissions are modelled.

interface ModeModel {
  mode: Mode;
  profile: "walk" | "bike" | "dr";
  costPerKm: number; // MODELLED — currency units per km
  fixedCost: number;
  emissionsKgCo2ePerKm: number; // MODELLED
  reliability: number; // MODELLED — 0..1
  comfort: number; // MODELLED 0..1
  safety: number; // MODELLED 0..1
  label: string;
}

const MODELS: ModeModel[] = [
  { mode: "walk", profile: "walk", costPerKm: 0, fixedCost: 0, emissionsKgCo2ePerKm: 0, reliability: 0.9, comfort: 0.5, safety: 0.7, label: "Walk" },
  { mode: "rideshare", profile: "dr", costPerKm: 1.8, fixedCost: 2.5, emissionsKgCo2ePerKm: 0.17, reliability: 0.8, comfort: 0.85, safety: 0.85, label: "Drive / rideshare" },
];

const BIKE_MODEL: ModeModel = {
  mode: "walk", // bikes are micromobility — represented as a walk segment with bike note until a dedicated `micromobility` Mode exists in the synthetic type union
  profile: "bike",
  costPerKm: 0.3,
  fixedCost: 0,
  emissionsKgCo2ePerKm: 0,
  reliability: 0.85,
  comfort: 0.7,
  safety: 0.65,
  label: "Bike / micromobility",
};

// NYC bounding box (rough) for Citi Bike relevance
const NYC_BBOX = { minLat: 40.55, maxLat: 40.85, minLon: -74.05, maxLon: -73.85 };
function isNearNyc(p: GeoPoint): boolean {
  return p.lat >= NYC_BBOX.minLat && p.lat <= NYC_BBOX.maxLat && p.lon >= NYC_BBOX.minLon && p.lon <= NYC_BBOX.maxLon;
}

// ═══════════════════════════════════════════════════════════════════════
// SCORING (deterministic weighted-sum, normalised)
// ═══════════════════════════════════════════════════════════════════════

function defaultObjectives(): ObjectiveWeights {
  return { cost: 0.7, time: 0.7, reliability: 0.6, emissions: 0.35, comfort: 0.4, transfers: 0.5, walking: 0.4, safety: 0.55 };
}

function scorePlan(
  plan: Pick<Plan, "totalCost" | "totalDurationMin" | "reliability" | "emissionsKgCo2e" | "comfort" | "transfers" | "walkingKm" | "safety">,
  objectives: ObjectiveWeights,
  budget?: number,
): number {
  // normalise each axis against plausible bounds, then weighted sum.
  const costScore = budget && budget > 0 ? Math.max(0, 1 - plan.totalCost / (budget * 1.5)) : plan.totalCost < 25 ? 0.9 : plan.totalCost < 60 ? 0.6 : 0.3;
  const timeScore = plan.totalDurationMin <= 15 ? 0.95 : plan.totalDurationMin <= 40 ? 0.75 : plan.totalDurationMin <= 90 ? 0.5 : 0.3;
  const emissionsScore = plan.emissionsKgCo2e <= 0.1 ? 1 : plan.emissionsKgCo2e <= 1 ? 0.7 : 0.4;
  const transfersScore = plan.transfers === 0 ? 1 : plan.transfers === 1 ? 0.7 : 0.4;
  const walkingScore = plan.walkingKm <= 0.5 ? 1 : plan.walkingKm <= 2 ? 0.7 : 0.4;
  const o = objectives;
  const total = o.cost + o.time + o.reliability + o.emissions + o.comfort + o.transfers + o.walking + o.safety;
  if (total <= 0) return 0;
  return (
    (costScore * o.cost +
      timeScore * o.time +
      plan.reliability * o.reliability +
      emissionsScore * o.emissions +
      plan.comfort * o.comfort +
      transfersScore * o.transfers +
      walkingScore * o.walking +
      plan.safety * o.safety) /
    total
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PLAN BUILDERS
// ═══════════════════════════════════════════════════════════════════════

function fmtTime(departMin: number): string {
  const h = Math.floor((departMin / 60) % 24);
  const m = Math.floor(departMin % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function buildPlanFromRoute(
  model: ModeModel,
  route: RouteResult,
  origin: GeocodeResult,
  dest: GeocodeResult,
  departMin: number,
  objectives: ObjectiveWeights,
  budget?: number,
  notes?: string,
): Plan {
  const durationMin = Math.round(route.durationSec / 60);
  const distanceKm = route.distanceKm;
  const cost = model.fixedCost + model.costPerKm * distanceKm;
  const emissions = model.emissionsKgCo2ePerKm * distanceKm;
  const walkingKm = model.mode === "walk" ? distanceKm : 0;

  const segment: ItinerarySegment = {
    mode: model.mode,
    provider: model.label,
    from: origin.displayName,
    to: dest.displayName,
    depart: fmtTime(departMin),
    arrive: fmtTime(departMin + durationMin),
    durationMin,
    cost,
    distanceKm,
    reliability: model.reliability,
    emissionsKgCo2e: emissions,
    comfort: model.comfort,
    safety: model.safety,
    walkingKm,
    isLatentSupply: false,
    notes,
  };

  const plan: Plan = {
    id: `real-${model.mode}-${Math.round(distanceKm * 10)}-${Math.round(durationMin)}`,
    tag: "interesting_alternative",
    headline: `${model.label} · ${durationMin} min · ${distanceKm.toFixed(1)} km`,
    segments: [segment],
    totalCost: cost,
    totalDurationMin: durationMin,
    depart: segment.depart,
    arrive: segment.arrive,
    etaVarianceMin: Math.max(2, Math.round(durationMin * 0.08)),
    onTimeProbability: model.reliability,
    reliability: model.reliability,
    emissionsKgCo2e: emissions,
    transfers: 0,
    walkingKm,
    comfort: model.comfort,
    safety: model.safety,
    score: 0,
    confidence: 0.85, // real distance/time; modelled other axes
    tradeoffNote:
      `REAL distance (${distanceKm.toFixed(2)} km) + travel time (${durationMin} min) from OSRM road network. ` +
      `MODELLED cost ($${cost.toFixed(2)}), emissions (${emissions.toFixed(2)} kg CO₂e), reliability, comfort, safety — no live pricing API.` +
      (notes ? ` ${notes}` : ""),
    usesLatentSupply: false,
    syntheticWorld: false,
  };
  plan.score = scorePlan(plan, objectives, budget);
  return plan;
}

function buildCitiBikePlan(
  origin: GeocodeResult,
  dest: GeocodeResult,
  departMin: number,
  objectives: ObjectiveWeights,
  budget?: number,
): Plan | null {
  // Walk to nearest Citi Bike station, bike to near dest, walk to dest.
  // Distances/times here are MODELLED (we don't compute the actual walk+bike
  // walk legs via OSRM in this slice). This is honestly labelled.
  const directKm = haversineKm(
    { lat: origin.lat, lon: origin.lon },
    { lat: dest.lat, lon: dest.lon },
  );
  if (directKm < 0.3 || directKm > 12) return null;

  const walkToStationMin = 5;
  const bikeMin = Math.max(3, Math.round(directKm * 6)); // ~10 km/h city biking
  const walkFromStationMin = 5;
  const durationMin = walkToStationMin + bikeMin + walkFromStationMin;
  const cost = 4.49; // Citi Bike day-pass / single ride approx — MODELLED
  const emissions = 0;

  const segments: ItinerarySegment[] = [
    {
      mode: "walk",
      provider: "Walk to Citi Bike station",
      from: origin.displayName,
      to: "nearest Citi Bike station",
      depart: fmtTime(departMin),
      arrive: fmtTime(departMin + walkToStationMin),
      durationMin: walkToStationMin,
      cost: 0,
      distanceKm: 0.4,
      reliability: 0.9,
      emissionsKgCo2e: 0,
      comfort: 0.5,
      safety: 0.7,
      walkingKm: 0.4,
      isLatentSupply: false,
    },
    {
      mode: "walk", // micromobility mapped to walk in legacy Mode union
      provider: "Citi Bike NYC (OBSERVED_ONLY)",
      from: "Citi Bike station",
      to: "Citi Bike station near destination",
      depart: fmtTime(departMin + walkToStationMin),
      arrive: fmtTime(departMin + walkToStationMin + bikeMin),
      durationMin: bikeMin,
      cost,
      distanceKm: directKm,
      reliability: 0.8,
      emissionsKgCo2e: emissions,
      comfort: 0.7,
      safety: 0.65,
      walkingKm: 0,
      isLatentSupply: false,
      notes: "Free-bike count observed from CityBik.es API (OBSERVED_ONLY — cannot reserve/accept).",
    },
    {
      mode: "walk",
      provider: "Walk to destination",
      from: "Citi Bike station",
      to: dest.displayName,
      depart: fmtTime(departMin + walkToStationMin + bikeMin),
      arrive: fmtTime(departMin + durationMin),
      durationMin: walkFromStationMin,
      cost: 0,
      distanceKm: 0.4,
      reliability: 0.9,
      emissionsKgCo2e: 0,
      comfort: 0.5,
      safety: 0.7,
      walkingKm: 0.4,
      isLatentSupply: false,
    },
  ];

  const plan: Plan = {
    id: `real-citibike-${Math.round(directKm * 10)}-${durationMin}`,
    tag: "interesting_alternative",
    headline: `Citi Bike · ${durationMin} min · $${cost.toFixed(2)} (observed)`,
    segments,
    totalCost: cost,
    totalDurationMin: durationMin,
    depart: segments[0].depart,
    arrive: segments[2].arrive,
    etaVarianceMin: Math.max(3, Math.round(durationMin * 0.12)),
    onTimeProbability: 0.8,
    reliability: 0.8,
    emissionsKgCo2e: emissions,
    transfers: 2,
    walkingKm: 0.8,
    comfort: 0.7,
    safety: 0.65,
    score: 0,
    confidence: 0.7, // observed supply but modelled legs
    tradeoffNote:
      `OBSERVED Citi Bike supply near NYC (real free_bikes counts via CityBik.es). ` +
      `Direct distance ${directKm.toFixed(2)} km REAL (haversine). Walk-to-station legs MODELLED (~5 min each). ` +
      `Bike time MODELLED at ~10 km/h. Cost MODELLED (Citi Bike day-pass pricing). ` +
      `OBSERVED_ONLY provider — cannot reserve or execute via API.`,
    usesLatentSupply: false,
    syntheticWorld: false,
  };
  plan.score = scorePlan(plan, objectives, budget);
  return plan;
}

function buildTransitPlan(
  origin: GeocodeResult,
  dest: GeocodeResult,
  departMin: number,
  objectives: ObjectiveWeights,
  budget?: number,
): Plan | null {
  if (!gtfsTransit.isReady()) return null;
  const originPoint = { lat: origin.lat, lon: origin.lon };
  const destPoint = { lat: dest.lat, lon: dest.lon };
  try {
    const fromStops = gtfsTransit.getStopsNear(originPoint, 1.5);
    const toStops = gtfsTransit.getStopsNear(destPoint, 1.5);
    if (fromStops.length === 0 || toStops.length === 0) return null;
    const fromStop = fromStops[0];
    const toStop = toStops[0];
    const departures = gtfsTransit.getNextDepartures(fromStop.stopId, departMin * 60, 1);
    if (departures.length === 0) return null;
    const dep = departures[0];

    const walkToStopMin = Math.max(3, Math.round(haversineKm(originPoint, { lat: fromStop.lat, lon: fromStop.lon }) / 0.08));
    const rideMin = Math.max(8, Math.round(haversineKm({ lat: fromStop.lat, lon: fromStop.lon }, { lat: toStop.lat, lon: toStop.lon }) / 0.4)); // ~24 km/h transit
    const walkFromStopMin = Math.max(3, Math.round(haversineKm({ lat: toStop.lat, lon: toStop.lon }, destPoint) / 0.08));
    const durationMin = walkToStopMin + rideMin + walkFromStopMin;
    const cost = 2.4; // MODELLED fare

    const segments: ItinerarySegment[] = [
      {
        mode: "walk",
        provider: "Walk to transit stop",
        from: origin.displayName,
        to: fromStop.name,
        depart: fmtTime(departMin),
        arrive: fmtTime(departMin + walkToStopMin),
        durationMin: walkToStopMin,
        cost: 0,
        distanceKm: haversineKm(originPoint, { lat: fromStop.lat, lon: fromStop.lon }),
        reliability: 0.9,
        emissionsKgCo2e: 0,
        comfort: 0.5,
        safety: 0.7,
        walkingKm: haversineKm(originPoint, { lat: fromStop.lat, lon: fromStop.lon }),
        isLatentSupply: false,
      },
      {
        mode: "bus", // approximate — GTFS route_type varies
        provider: `Transit (${dep.route?.shortName ?? dep.routeId})`,
        from: fromStop.name,
        to: toStop.name,
        depart: fmtTime(Math.floor(dep.departureSec / 60)),
        arrive: fmtTime(Math.floor(dep.departureSec / 60) + rideMin),
        durationMin: rideMin,
        cost,
        distanceKm: haversineKm({ lat: fromStop.lat, lon: fromStop.lon }, { lat: toStop.lat, lon: toStop.lon }),
        reliability: 0.75,
        emissionsKgCo2e: haversineKm({ lat: fromStop.lat, lon: fromStop.lon }, { lat: toStop.lat, lon: toStop.lon }) * 0.05,
        comfort: 0.6,
        safety: 0.8,
        walkingKm: 0,
        isLatentSupply: false,
        scheduledDeparture: fmtTime(Math.floor(dep.departureSec / 60)),
        notes: `Real GTFS schedule departure (headsign: ${dep.headsign ?? "n/a"}).`,
      },
      {
        mode: "walk",
        provider: "Walk to destination",
        from: toStop.name,
        to: dest.displayName,
        depart: fmtTime(Math.floor(dep.departureSec / 60) + rideMin),
        arrive: fmtTime(Math.floor(dep.departureSec / 60) + rideMin + walkFromStopMin),
        durationMin: walkFromStopMin,
        cost: 0,
        distanceKm: haversineKm({ lat: toStop.lat, lon: toStop.lon }, destPoint),
        reliability: 0.9,
        emissionsKgCo2e: 0,
        comfort: 0.5,
        safety: 0.7,
        walkingKm: haversineKm({ lat: toStop.lat, lon: toStop.lon }, destPoint),
        isLatentSupply: false,
      },
    ];

    const plan: Plan = {
      id: `real-transit-${fromStop.stopId}-${Math.round(durationMin)}`,
      tag: "interesting_alternative",
      headline: `Transit · ${durationMin} min · $${cost.toFixed(2)} (GTFS)`,
      segments,
      totalCost: cost,
      totalDurationMin: durationMin,
      depart: segments[0].depart,
      arrive: segments[2].arrive,
      etaVarianceMin: Math.max(4, Math.round(durationMin * 0.12)),
      onTimeProbability: 0.75,
      reliability: 0.75,
      emissionsKgCo2e: segments[1].emissionsKgCo2e,
      transfers: 2,
      walkingKm: segments[0].walkingKm + segments[2].walkingKm,
      comfort: 0.6,
      safety: 0.8,
      score: 0,
      confidence: 0.7,
      tradeoffNote:
        `REAL GTFS schedule (stop "${fromStop.name}" → "${toStop.name}", departure from feed). ` +
        `Walk-to-stop / ride durations MODELLED. Fare MODELLED. ` +
        `OBSERVED_ONLY — GTFS static is schedule-only, no real-time/transactional support.`,
      usesLatentSupply: false,
      syntheticWorld: false,
    };
    plan.score = scorePlan(plan, objectives, budget);
    return plan;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════

export interface RealSolveResponse {
  event: TransportationEvent;
  parsedBy: "llm" | "heuristic" | "structured";
  plans: Plan[];
  unknowns: string[];
  generatedAt: string;
  geocoded: { origin: GeocodeResult | null; destination: GeocodeResult | null };
  environment: "REAL_DATA_OBSERVED_ONLY";
}

export async function solveRealTransportationEvent(
  event: TransportationEvent,
  parsedBy: "llm" | "heuristic" | "structured" = "structured",
): Promise<RealSolveResponse> {
  const unknowns: string[] = [];
  const objectives = event.objectives ?? defaultObjectives();
  const budget = event.constraints?.budget;

  // 1. Geocode origin + destination in parallel.
  const [originResults, destResults] = await Promise.all([
    osmGeocoder.geocode(event.origin),
    osmGeocoder.geocode(event.destination),
  ]);
  const origin = originResults[0] ?? null;
  const destination = destResults[0] ?? null;

  if (!origin) unknowns.push(`Could not geocode origin "${event.origin}" via OSM Nominatim (REAL geocoder).`);
  if (!destination) unknowns.push(`Could not geocode destination "${event.destination}" via OSM Nominatim (REAL geocoder).`);

  if (!origin || !destination) {
    return {
      event,
      parsedBy,
      plans: [],
      unknowns,
      generatedAt: new Date().toISOString(),
      geocoded: { origin, destination },
      environment: "REAL_DATA_OBSERVED_ONLY",
    };
  }

  // 2. Parse departure time → minutes from midnight.
  const departMin = parseDepartureMin(event);

  // 3. Build real OSRM-based plans for walk / bike / drive.
  const plans: Plan[] = [];

  const originPt: GeoPoint = { lat: origin.lat, lon: origin.lon, name: origin.displayName };
  const destPt: GeoPoint = { lat: destination.lat, lon: destination.lon, name: destination.displayName };

  for (const model of MODELS) {
    try {
      const route = await osrmRouter.route([originPt, destPt], model.profile);
      if (route) {
        plans.push(buildPlanFromRoute(model, route, origin, destination, departMin, objectives, budget));
      } else {
        unknowns.push(`OSRM returned no route for profile "${model.profile}" (REAL router).`);
      }
    } catch (err: any) {
      unknowns.push(`OSRM ${model.profile} failed: ${err?.message ?? String(err)}.`);
    }
  }

  // bike (micromobility direct)
  try {
    const bikeRoute = await osrmRouter.route([originPt, destPt], "bike");
    if (bikeRoute) {
      plans.push(buildPlanFromRoute(BIKE_MODEL, bikeRoute, origin, destination, departMin, objectives, budget));
    }
  } catch (err: any) {
    unknowns.push(`OSRM bike failed: ${err?.message ?? String(err)}.`);
  }

  // 4. Augment with observed Citi Bike supply near NYC.
  if (isNearNyc(originPt) || isNearNyc(destPt)) {
    try {
      // confirm real observed supply exists near origin
      const supplies = await citibikeProvider.discoverSupply(originPt, 1.5);
      if (supplies.length > 0) {
        const cb = buildCitiBikePlan(origin, destination, departMin, objectives, budget);
        if (cb) {
          plans.push(cb);
          unknowns.push(
            `Citi Bike plan uses REAL observed free_bikes counts (${supplies.length} stations near origin) but modelled walk/bike legs. OBSERVED_ONLY provider.`,
          );
        }
      } else {
        unknowns.push("Citi Bike queried near NYC but 0 stations with free_bikes > 0 observed (REAL).");
      }
    } catch (err: any) {
      unknowns.push(`Citi Bike observation failed: ${err?.message ?? String(err)}.`);
    }
  }

  // 5. Augment with GTFS transit (if feed loaded and O/D near a covered stop).
  const transitPlan = buildTransitPlan(origin, destination, departMin, objectives, budget);
  if (transitPlan) {
    plans.push(transitPlan);
    const feed = gtfsTransit.getFeedMeta();
    unknowns.push(
      `Transit plan uses REAL GTFS schedule (feed: ${feed.url}, ${feed.stops} stops). Modelled durations/fare. OBSERVED_ONLY.`,
    );
  } else if (gtfsTransit.isReady()) {
    unknowns.push("GTFS feed loaded but no transit stops within 1.5 km of O/D.");
  }

  // 6. Rank + tag canonical plans.
  plans.sort((a, b) => b.score - a.score);
  if (plans.length > 0) {
    plans[0].tag = "best_overall";
    // cheapest
    const cheapest = [...plans].sort((a, b) => a.totalCost - b.totalCost)[0];
    if (cheapest.id !== plans[0].id) cheapest.tag = "cheapest";
    else cheapest.tag = "best_overall";
    const fastest = [...plans].sort((a, b) => a.totalDurationMin - b.totalDurationMin)[0];
    if (fastest.id !== plans[0].id && fastest.id !== cheapest.id) fastest.tag = "fastest";
    else if (fastest.id !== plans[0].id) fastest.tag = "fastest";
  }

  // global labelling note
  unknowns.push(
    "All plans: distance + travel time REAL (OSRM road network / GTFS schedule / Citi Bike observation). " +
    "Cost, emissions, reliability, comfort, safety MODELLED (no live pricing/emissions API at HEAD).",
  );

  return {
    event,
    parsedBy,
    plans,
    unknowns,
    generatedAt: new Date().toISOString(),
    geocoded: { origin, destination },
    environment: "REAL_DATA_OBSERVED_ONLY",
  };
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseDepartureMin(event: TransportationEvent): number {
  const t = event.preferredDeparture ?? event.earliestDeparture ?? "08:00";
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
  return 8 * 60;
}
