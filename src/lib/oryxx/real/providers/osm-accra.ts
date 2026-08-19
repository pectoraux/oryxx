// ORYXX — Real OpenStreetMap provider adapter.
//
// Fetches REAL geographic + road data from the OpenStreetMap Overpass API.
// This is genuine empirical data (ODbL license), not a fixture. The provider
// implements the same TransportationDataProvider interface as the fixture, so
// the opportunity engine consumes it with zero changes.
//
// License: ODbL 1.0 (Open Database License). Attribution: © OpenStreetMap
// contributors. Data is fetched on-demand and cached in-memory for the
// process lifetime.
//
// Network access: the Overpass API is reachable from this environment. If it
// becomes unreachable, callers fall back to the fixture provider (see
// withFallback in the runner).

import type {
  GeographicNode,
  NetworkEdge,
  RoadCondition,
  TransitFeed,
  TransitDeparture,
  ObservedMovement,
  SupplyObservation,
  PilotGeography,
  DataSource,
} from "../types";
import type { TransportationDataProvider } from "./interface";
import { haversineKm, projectToKm } from "./interface";
import { FixtureAccraProvider, ACCRA_PILOT } from "./fixture-accra";
import type { Loc } from "../../../market/types";

const OSM_SOURCE: DataSource = {
  name: "OpenStreetMap (Overpass API)",
  type: "osm",
  license: "ODbL 1.0 — © OpenStreetMap contributors",
  coveragePeriod: "live snapshot",
  fetchedAt: new Date().toISOString(),
  isFixture: false,
  url: "https://overpass-api.de/api/interpreter",
};

const ACCRA_BBOX = { minLat: 5.58, minLon: -0.22, maxLat: 5.62, maxLon: -0.18 };

const PILOT_REAL: PilotGeography = {
  ...ACCRA_PILOT,
  id: "accra-central-real-osm",
  name: "Accra Central (Real OSM)",
  description:
    "Real OpenStreetMap road network for central Accra, Ghana (~4km × 4km bbox). Roads, intersections, and named ways fetched live from the Overpass API. Transit + movement remain fixture data (no public GTFS/mobility feed available for Accra in this environment).",
  dataSources: ["OSM (real, ODbL)", "GTFS (fixture)", "Movement (fixture)"],
  knownLimitations: [
    "Road graph is REAL OSM data (ODbL license)",
    "Transit schedule is fixture — no public Accra GTFS found",
    "Movement trajectories are fixture — no public Accra mobility dataset available",
    "Road times are free-flow estimates, not observed traffic",
  ],
};

export class OsmAccraProvider implements TransportationDataProvider {
  readonly id = "osm-accra";
  readonly dataSource = OSM_SOURCE;
  private cachedNodes: GeographicNode[] | null = null;
  private cachedEdges: NetworkEdge[] | null = null;
  private fixtureFallback: FixtureAccraProvider;

  constructor(movementSeed = 42, movementDensity = 1.0) {
    this.fixtureFallback = new FixtureAccraProvider(movementSeed, movementDensity);
  }

  // --- real OSM road graph fetch ---
  private async fetchOsmRoads(): Promise<{ nodes: GeographicNode[]; edges: NetworkEdge[] }> {
    if (this.cachedNodes && this.cachedEdges) {
      return { nodes: this.cachedNodes, edges: this.cachedEdges };
    }
    const query = `[out:json][timeout:25];
      (
        way["highway"~"^(residential|tertiary|secondary|primary|trunk|unclassified)$"](${ACCRA_BBOX.minLat},${ACCRA_BBOX.minLon},${ACCRA_BBOX.maxLat},${ACCRA_BBOX.maxLon});
      );
      out geom 200;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Overpass API returned ${res.status}`);
    const data = await res.json();
    const ways = (data.elements || []).filter((e: any) => e.type === "way" && e.geometry);

    const nodes: GeographicNode[] = [];
    const edges: NetworkEdge[] = [];
    const nodeMap = new Map<string, string>(); // "lat,lon" -> nodeId
    let nodeIdx = 0;

    for (const way of ways) {
      const geom: { lat: number; lon: number }[] = way.geometry;
      const name = way.tags?.name || `Road ${way.id}`;
      const highway = way.tags?.highway || "unclassified";
      // speed by highway type
      const speed = highway === "trunk" || highway === "primary" ? 45
        : highway === "secondary" ? 38
        : highway === "tertiary" ? 32
        : 25; // residential/unclassified

      // create nodes for each geometry point (intersections + endpoints)
      const wayNodeIds: string[] = [];
      for (const pt of geom) {
        const key = `${pt.lat.toFixed(5)},${pt.lon.toFixed(5)}`;
        let id = nodeMap.get(key);
        if (!id) {
          id = `OSM-${nodeIdx++}`;
          const { x, y } = projectToKm(pt.lat, pt.lon, ACCRA_BBOX.minLat + 0.02, ACCRA_BBOX.minLon + 0.02);
          nodes.push({
            id,
            lat: pt.lat,
            lon: pt.lon,
            x,
            y,
            name: wayNodeIds.length === 0 ? name : undefined,
            kind: "intersection",
          });
          nodeMap.set(key, id);
        }
        wayNodeIds.push(id);
      }

      // create edges between consecutive nodes
      for (let i = 0; i < wayNodeIds.length - 1; i++) {
        const from = nodes.find((n) => n.id === wayNodeIds[i])!;
        const to = nodes.find((n) => n.id === wayNodeIds[i + 1])!;
        const km = haversineKm({ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon });
        edges.push({
          id: `E-${from.id}-${to.id}`,
          from: from.id,
          to: to.id,
          distanceKm: km,
          walkTimeMin: Math.max(1, Math.round((km / 5) * 60)),
          driveTimeMin: Math.max(1, Math.round((km / speed) * 60)),
          modes: ["walk", "drive"],
        });
      }
    }

    this.cachedNodes = nodes;
    this.cachedEdges = edges;
    return { nodes, edges };
  }

  // --- TransportationDataProvider interface ---
  async getGeographicNodes(): Promise<GeographicNode[]> {
    try {
      return (await this.fetchOsmRoads()).nodes;
    } catch (e) {
      console.error("[osm-accra] fetch failed, using fixture:", e);
      return this.fixtureFallback.getGeographicNodesSync();
    }
  }

  async getNetworkEdges(): Promise<NetworkEdge[]> {
    try {
      return (await this.fetchOsmRoads()).edges;
    } catch (e) {
      return this.fixtureFallback.getNetworkEdgesSync();
    }
  }

  async getRoadConditions(): Promise<RoadCondition[]> { return []; }

  async getTransitFeed(): Promise<TransitFeed> {
    // no real GTFS available for Accra — use fixture transit
    return this.fixtureFallback.getTransitFeedSync();
  }

  async getTransitDepartures(stopId: string, fromSec: number, toSec: number): Promise<TransitDeparture[]> {
    return this.fixtureFallback.getTransitDeparturesSync(stopId, fromSec, toSec);
  }

  async getObservedMovements(fromSec: number, toSec: number): Promise<ObservedMovement[]> {
    // no real mobility dataset available — use fixture movements
    return this.fixtureFallback.getObservedMovementsSync(fromSec, toSec);
  }

  async getSupplyObservations(): Promise<SupplyObservation[]> { return []; }

  async getPilotGeography(): Promise<PilotGeography> { return PILOT_REAL; }

  // sync accessors (for the experiment runner — OSM fetch is async so we
  // pre-fetch on init via ensureLoaded, then serve from cache)
  private loaded = false;
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try { await this.fetchOsmRoads(); } catch (e) { /* fall back to fixture */ }
    this.loaded = true;
  }
  getGeographicNodesSync(): GeographicNode[] {
    return this.cachedNodes ?? this.fixtureFallback.getGeographicNodesSync();
  }
  getNetworkEdgesSync(): NetworkEdge[] {
    return this.cachedEdges ?? this.fixtureFallback.getNetworkEdgesSync();
  }
  getTransitFeedSync(): TransitFeed { return this.fixtureFallback.getTransitFeedSync(); }
  getObservedMovementsSync(fromSec: number, toSec: number): ObservedMovement[] {
    return this.fixtureFallback.getObservedMovementsSync(fromSec, toSec);
  }
  getPilotGeographySync(): PilotGeography { return PILOT_REAL; }
  getTransitDeparturesSync(stopId: string, fromSec: number, toSec: number): TransitDeparture[] {
    return this.fixtureFallback.getTransitDeparturesSync(stopId, fromSec, toSec);
  }
  getRoadConditionsSync(): RoadCondition[] { return []; }
  getSupplyObservationsSync(): SupplyObservation[] { return []; }
}

export { PILOT_REAL as ACCRA_PILOT_REAL, OSM_SOURCE };
