// ORYXX — Fixture provider for the Accra Central pilot geography.
//
// This is a FIXTURE dataset: it has the exact shape of real OSM/GTFS/movement
// feeds but is generated deterministically for reproducibility without network
// access. Every DataSource is labelled isFixture: true. The adapter can be
// swapped for a real feed (OpenStreetMap, transit agency GTFS, DGT mobility
// data) with zero engine changes.
//
// The fixture models a realistic ~8km × 6km urban corridor with:
//   - 48 road/walk nodes (OSM-format)
//   - 72 network edges with walk/drive times
//   - 6 transit routes (bus + metro) in GTFS format (stops, routes, trips, calendars)
//   - ~180 observed movements (commuter trajectories, anonymized)
//
// WHY ACCRA: the user's timezone is Africa/Accra. The pilot should not assume
// US/Europe as the default world model (master prompt §33).

import type {
  GeographicNode,
  NetworkEdge,
  RoadCondition,
  TransitFeed,
  TransitStop,
  TransitRoute,
  TransitTrip,
  TransitService,
  TransitDeparture,
  ObservedMovement,
  SupplyObservation,
  PilotGeography,
  DataSource,
} from "../types";
import type { TransportationDataProvider } from "./interface";
import { projectToKm, haversineKm } from "./interface";
import { rng } from "../../market/generate";
import type { Loc } from "../../market/types";

const CENTER_LAT = 5.6037;
const CENTER_LON = -0.1870;

const FIXTURE_SOURCE: DataSource = {
  name: "Accra Central Fixture",
  type: "fixture",
  license: "ORYXX internal fixture — synthetic but real-shaped (stands in for OSM + transit GTFS + mobility trajectories)",
  coveragePeriod: "representative weekday",
  fetchedAt: "2025-01-01T00:00:00Z",
  isFixture: true,
};

// --- Road/walk nodes: a grid of intersections + POIs -----------------------
function buildNodes(): GeographicNode[] {
  const nodes: GeographicNode[] = [];
  // 6×8 grid of intersections spanning ~8km × 6km
  const lats = [5.58, 5.59, 5.60, 5.61, 5.62, 5.63];
  const lons = [-0.22, -0.21, -0.20, -0.19, -0.18, -0.17, -0.16, -0.15];
  let ni = 0;
  for (let i = 0; i < lats.length; i++) {
    for (let j = 0; j < lons.length; j++) {
      const lat = lats[i];
      const lon = lons[j];
      const { x, y } = projectToKm(lat, lon, CENTER_LAT, CENTER_LON);
      const names = ["Kaneshie", "Circle", "Accra Central", "Osu", "Labadi", "Airport", "Legon", "Madina", "Dansoman", "Korle-Bu", "Trade Fair", "Tema Station"];
      nodes.push({
        id: `N${ni++}`,
        lat, lon, x, y,
        name: ni <= names.length ? names[(i * lons.length + j) % names.length] : `Junction ${ni}`,
        kind: "intersection",
      });
    }
  }
  // named POIs / stops
  const pois: { name: string; lat: number; lon: number; kind: GeographicNode["kind"] }[] = [
    { name: "Kotoka Airport", lat: 5.6052, lon: -0.1667, kind: "poi" },
    { name: "Accra Mall", lat: 5.6147, lon: -0.1769, kind: "poi" },
    { name: "Makola Market", lat: 5.5603, lon: -0.2089, kind: "poi" },
    { name: "Independence Arch", lat: 5.5470, lon: -0.1980, kind: "poi" },
    { name: "37 Station", lat: 5.5950, lon: -0.1810, kind: "station" },
    { name: "Circle Station", lat: 5.5800, lon: -0.2050, kind: "station" },
  ];
  for (const p of pois) {
    const { x, y } = projectToKm(p.lat, p.lon, CENTER_LAT, CENTER_LON);
    nodes.push({ id: `P${p.name.replace(/\s/g, "")}`, lat: p.lat, lon: p.lon, x, y, name: p.name, kind: p.kind });
  }
  return nodes;
}

// --- Network edges: connect adjacent grid nodes -----------------------------
function buildEdges(nodes: GeographicNode[]): NetworkEdge[] {
  const edges: NetworkEdge[] = [];
  const walkSpeed = 5; // km/h
  const driveSpeed = 28; // km/h urban avg
  // connect each node to its nearest 2-3 neighbors
  for (const a of nodes) {
    const dists = nodes
      .filter((b) => b.id !== a.id)
      .map((b) => ({ b, d: haversineKm({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 3);
    for (const { b, d } of dists) {
      if (d > 3.5) continue; // don't connect far-flung nodes directly
      const id = `E-${a.id}-${b.id}`;
      edges.push({
        id,
        from: a.id,
        to: b.id,
        distanceKm: d,
        walkTimeMin: Math.max(2, Math.round((d / walkSpeed) * 60)),
        driveTimeMin: Math.max(1, Math.round((d / driveSpeed) * 60)),
        modes: ["walk", "drive"],
      });
    }
  }
  return edges;
}

// --- Transit (GTFS-format fixture) ------------------------------------------
function buildTransitFeed(): TransitFeed {
  // stops — reuse some POI nodes + add dedicated stops
  const stops: TransitStop[] = [
    { id: "S1", lat: 5.5800, lon: -0.2050, x: 0, y: 0, name: "Circle Station", code: "CIR", kind: "stop", locationType: "station" },
    { id: "S2", lat: 5.5950, lon: -0.1810, x: 0, y: 0, name: "37 Station", code: "37", kind: "stop", locationType: "station" },
    { id: "S3", lat: 5.6052, lon: -0.1667, x: 0, y: 0, name: "Airport", code: "APT", kind: "stop", locationType: "station" },
    { id: "S4", lat: 5.6147, lon: -0.1769, x: 0, y: 0, name: "Accra Mall", code: "MAL", kind: "stop" },
    { id: "S5", lat: 5.5603, lon: -0.2089, x: 0, y: 0, name: "Makola Market", code: "MAK", kind: "stop" },
    { id: "S6", lat: 5.5470, lon: -0.1980, x: 0, y: 0, name: "Independence Arch", code: "IAR", kind: "stop" },
    { id: "S7", lat: 5.5900, lon: -0.1900, x: 0, y: 0, name: "Ridge", code: "RDG", kind: "stop" },
    { id: "S8", lat: 5.6200, lon: -0.1600, x: 0, y: 0, name: "East Legon", code: "ELG", kind: "stop" },
  ].map((s) => {
    const { x, y } = projectToKm(s.lat, s.lon, CENTER_LAT, CENTER_LON);
    return { ...s, x, y } as TransitStop;
  });

  const routes: TransitRoute[] = [
    { id: "R1", agencyId: "MERO", shortName: "356", longName: "Circle – Airport – East Legon", mode: "bus", color: "#dc2626" },
    { id: "R2", agencyId: "MERO", shortName: "255", longName: "Makola – 37 – Accra Mall", mode: "bus", color: "#2563eb" },
    { id: "R3", agencyId: "MERO", shortName: "383", longName: "Independence Arch – Ridge – 37", mode: "bus", color: "#16a34a" },
    { id: "R4", agencyId: "AMRO", shortName: "M1", longName: "Metro Line 1: Circle – 37 – Mall", mode: "metro", color: "#7c3aed" },
    { id: "R5", agencyId: "STC", shortName: "C9", longName: "STC Korle-Bu – Airport", mode: "bus", color: "#ea580c" },
    { id: "R6", agencyId: "MERO", shortName: "419", longName: "Danswan – Makola – East Legon", mode: "bus", color: "#0891b2" },
  ];

  // service calendar: runs weekdays
  const service: TransitService = {
    id: "SVC_WEEKDAY",
    days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
    startDate: "20250106",
    endDate: "20251231",
    exceptions: [],
  };

  // build trips with stop times — each route runs every ~15-30 min from 06:00 to 22:00
  const trips: TransitTrip[] = [];
  const routeStops: Record<string, string[]> = {
    R1: ["S1", "S2", "S3", "S8"],
    R2: ["S5", "S7", "S2", "S4"],
    R3: ["S6", "S7", "S2", "S3"],
    R4: ["S1", "S2", "S4"],
    R5: ["S6", "S7", "S3"],
    R6: ["S5", "S1", "S7", "S8"],
  };
  const headway: Record<string, number> = { R1: 1200, R2: 1500, R3: 1800, R4: 900, R5: 2400, R6: 1500 };

  for (const route of routes) {
    const stopIds = routeStops[route.id];
    const firstDep = 6 * 3600; // 06:00
    const lastDep = 21 * 3600; // 21:00
    for (let dep = firstDep; dep <= lastDep; dep += headway[route.id]) {
      const tripId = `${route.id}-T${dep}`;
      const stopTimes: TransitTrip["stopTimes"] = [];
      let t = dep;
      for (let i = 0; i < stopIds.length; i++) {
        const stopId = stopIds[i];
        const stop = stops.find((s) => s.id === stopId)!;
        if (i > 0) {
          const prev = stops.find((s) => s.id === stopIds[i - 1])!;
          const km = haversineKm({ lat: prev.lat, lon: prev.lon }, { lat: stop.lat, lon: stop.lon });
          const speed = route.mode === "metro" ? 38 : route.mode === "bus" ? 22 : 22;
          t += Math.max(180, Math.round((km / speed) * 3600) + 120); // dwell 2min
        }
        stopTimes.push({ stopId, arrivalSec: t, departureSec: t + 60 });
        t += 60;
      }
      trips.push({
        id: tripId,
        routeId: route.id,
        serviceId: service.id,
        headsign: stops.find((s) => s.id === stopIds[stopIds.length - 1])?.name ?? "",
        directionId: 0,
        stopTimes,
      });
    }
  }

  return {
    source: FIXTURE_SOURCE,
    stops,
    routes,
    trips,
    services: [service],
    agencyName: "Fixture Metro Transit Authority",
    coverageStart: "2025-01-06",
    coverageEnd: "2025-12-31",
  };
}

// --- Observed movements (anonymized trajectories) ---------------------------
// Models commuter patterns: morning rush into the centre, evening rush out.
function buildMovements(seed: number, density: number): ObservedMovement[] {
  const r = rng(seed * 31 + 17);
  const movements: ObservedMovement[] = [];
  const count = Math.round(180 * density);
  const nodes = buildNodes();
  // hubs — common origin/destination clusters
  const hubs = ["P37Station", "PCircleStation", "PMakolaMarket", "PAccraMall", "PKotokaAirport", "PIndependenceArch"];

  for (let i = 0; i < count; i++) {
    // pick origin/destination — bias toward hub-to-hub commutes
    const useHub = r() < 0.6;
    let origin: GeographicNode, dest: GeographicNode;
    if (useHub) {
      const h1 = hubs[Math.floor(r() * hubs.length)];
      const h2 = hubs[Math.floor(r() * hubs.length)];
      origin = nodes.find((n) => n.id === h1) ?? nodes[Math.floor(r() * nodes.length)];
      dest = nodes.find((n) => n.id === h2) ?? nodes[Math.floor(r() * nodes.length)];
    } else {
      origin = nodes[Math.floor(r() * nodes.length)];
      dest = nodes[Math.floor(r() * nodes.length)];
    }
    if (origin.id === dest.id) { i--; continue; }

    // departure time: cluster around morning/evening peaks
    const peak = r() < 0.5 ? (7 * 3600 + Math.floor(r() * 3600)) : (17 * 3600 + Math.floor(r() * 3600));
    const departure = r() < 0.7 ? peak : (8 * 3600 + Math.floor(r() * 10 * 3600));
    const km = haversineKm({ lat: origin.lat, lon: origin.lon }, { lat: dest.lat, lon: dest.lon });
    const speed = 32; // km/h driving
    const duration = Math.max(120, Math.round((km / speed) * 3600));
    const arrival = departure + duration;

    movements.push({
      id: `M${i + 1}`,
      origin: { x: origin.x, y: origin.y },
      destination: { x: dest.x, y: dest.y },
      originNode: origin.id,
      destNode: dest.id,
      departureSec: departure,
      arrivalSec: arrival,
      path: [{ x: origin.x, y: origin.y }, { x: dest.x, y: dest.y }],
      mode: "drive",
      observedCapacity: 1 + Math.floor(r() * 3), // taxi/private car with 1-4 seats
      source: FIXTURE_SOURCE,
      anonymized: true,
    });
  }
  return movements;
}

// --- Pilot geography --------------------------------------------------------
const PILOT: PilotGeography = {
  id: "accra-central",
  name: "Accra Central (Fixture)",
  bbox: { minLat: 5.547, minLon: -0.220, maxLat: 5.630, maxLon: -0.150 },
  centerLat: CENTER_LAT,
  centerLon: CENTER_LON,
  description:
    "An ~8km × 8km urban corridor in central Accra, Ghana. Fixture dataset standing in for OSM + transit agency GTFS + anonymized mobility trajectories. Real-shaped but synthetic — see data sources for swap plan.",
  dataSources: ["OSM (fixture)", "GTFS (fixture)", "Movement trajectories (fixture)"],
  knownLimitations: [
    "All data is fixture/synthetic, not empirical",
    "Road graph is a simplified grid, not the full OSM network",
    "Movement trajectories are generated, not observed",
    "No real GTFS-Realtime feed — delays are null",
    "Capacities/willingness are assumed, not observed",
  ],
};

// --- Provider implementation ------------------------------------------------
// Fixture data is built synchronously, so we expose both sync (for the
// experiment runner) and async (for the TransportationDataProvider interface)
// accessors. The async versions just wrap the sync ones.
export class FixtureAccraProvider implements TransportationDataProvider {
  readonly id = "fixture-accra";
  readonly dataSource = FIXTURE_SOURCE;
  private movementSeed: number;
  private movementDensity: number;

  constructor(movementSeed = 42, movementDensity = 1.0) {
    this.movementSeed = movementSeed;
    this.movementDensity = movementDensity;
  }

  // --- sync accessors (used by the experiment runner) ---
  getGeographicNodesSync(): GeographicNode[] { return buildNodes(); }
  getNetworkEdgesSync(): NetworkEdge[] { return buildEdges(buildNodes()); }
  getRoadConditionsSync(): RoadCondition[] { return []; }
  getTransitFeedSync(): TransitFeed { return buildTransitFeed(); }
  getObservedMovementsSync(fromSec: number, toSec: number): ObservedMovement[] {
    return buildMovements(this.movementSeed, this.movementDensity)
      .filter((m) => m.departureSec >= fromSec && m.departureSec <= toSec);
  }
  getSupplyObservationsSync(): SupplyObservation[] { return []; }
  getPilotGeographySync(): PilotGeography { return PILOT; }
  getTransitDeparturesSync(stopId: string, fromSec: number, toSec: number): TransitDeparture[] {
    const feed = buildTransitFeed();
    const out: TransitDeparture[] = [];
    for (const trip of feed.trips) {
      const st = trip.stopTimes.find((s) => s.stopId === stopId);
      if (!st) continue;
      if (st.departureSec >= fromSec && st.departureSec <= toSec) {
        const route = feed.routes.find((rt) => rt.id === trip.routeId)!;
        out.push({
          routeId: route.id, tripId: trip.id, stopId,
          routeMode: route.mode, routeShortName: route.shortName,
          scheduledDepartureSec: st.departureSec, observedDelaySec: null, observedAt: null, headsign: trip.headsign,
        });
      }
    }
    return out.sort((a, b) => a.scheduledDepartureSec - b.scheduledDepartureSec);
  }

  // --- async accessors (TransportationDataProvider interface) ---
  async getGeographicNodes(): Promise<GeographicNode[]> { return this.getGeographicNodesSync(); }
  async getNetworkEdges(): Promise<NetworkEdge[]> { return this.getNetworkEdgesSync(); }
  async getRoadConditions(): Promise<RoadCondition[]> { return this.getRoadConditionsSync(); }
  async getTransitFeed(): Promise<TransitFeed> { return this.getTransitFeedSync(); }
  async getTransitDepartures(stopId: string, fromSec: number, toSec: number): Promise<TransitDeparture[]> {
    return this.getTransitDeparturesSync(stopId, fromSec, toSec);
  }
  async getObservedMovements(fromSec: number, toSec: number): Promise<ObservedMovement[]> {
    return this.getObservedMovementsSync(fromSec, toSec);
  }
  async getSupplyObservations(): Promise<SupplyObservation[]> { return this.getSupplyObservationsSync(); }
  async getPilotGeography(): Promise<PilotGeography> { return this.getPilotGeographySync(); }
}

export { PILOT as ACCRA_PILOT, FIXTURE_SOURCE as ACCRA_FIXTURE_SOURCE, buildNodes, buildEdges, buildTransitFeed, buildMovements };
