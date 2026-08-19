// ORYXX — NYC Taxi provider with OBSERVED capacity (passenger_count).
//
// This is the key upgrade: NYC TLC yellow taxi data includes passenger_count,
// which means we can OBSERVE how many seats were occupied. A taxi with
// passenger_count=1 has 3 OBSERVED spare seats. This is Tier B evidence
// (observed capacity), not Tier C (inferred).
//
// Data: 500 real NYC yellow taxi trips from January 2024, bundled in
// data/nyc-taxi-trips.json. Converted from parquet using pyarrow.
// Zone centroids from data/nyc-taxi-zones.json (borough-level approximation).
//
// License: NYC TLC trip data is public domain.
// Source: https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page

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
import { FixtureAccraProvider } from "./fixture-accra";
import { readFileSync } from "fs";
import { join } from "path";
import type { NpdMovement, EvidenceField } from "../evidence/types";

const NYC_CENTER_LAT = 40.7128;
const NYC_CENTER_LON = -74.0060;

const NYC_TAXI_SOURCE: DataSource = {
  name: "NYC TLC Yellow Taxi Trips (passenger_count observed)",
  type: "movement",
  license: "Public domain — NYC Taxi & Limousine Commission",
  coveragePeriod: "2024-01 (sample of 500 trips)",
  fetchedAt: "2025-01-01T00:00:00Z",
  isFixture: false,
  url: "https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page",
};

const NYC_OSM_SOURCE: DataSource = {
  name: "OpenStreetMap (Overpass API) — NYC",
  type: "osm",
  license: "ODbL 1.0 — © OpenStreetMap contributors",
  coveragePeriod: "live snapshot",
  fetchedAt: new Date().toISOString(),
  isFixture: false,
  url: "https://overpass-api.de/api/interpreter",
};

const NYC_BBOX = { minLat: 40.60, minLon: -74.20, maxLat: 40.90, maxLon: -73.70 };

const PILOT_NYC: PilotGeography = {
  id: "nyc-real-capacity",
  name: "NYC (Real Taxi + Observed Capacity)",
  bbox: NYC_BBOX,
  centerLat: NYC_CENTER_LAT,
  centerLon: NYC_CENTER_LON,
  description:
    "Real NYC TLC yellow taxi trips with OBSERVED passenger_count (Tier B capacity evidence). 500 trips from January 2024. passenger_count tells us how many seats were occupied — so spare capacity is OBSERVED, not inferred. Zone centroids are borough-level approximations (spatial precision ~1-3km). Taxi/vendor IDs are opaque (no PII).",
  dataSources: ["NYC TLC Taxi Trips (real, public domain, passenger_count observed)", "OSM roads (real, ODbL)"],
  knownLimitations: [
    "Sample of 500 trips from one month — not statistically representative",
    "Zone centroids are borough-level, not exact coordinates (~1-3km precision)",
    "passenger_count is OBSERVED but driver willingness is NOT observed (Tier E assumed)",
    "A taxi with 1 passenger had 3 spare seats — but the taxi was on a dispatched trip, NOT available to ORYXX",
    "No transit GTFS for NYC loaded",
  ],
};

interface NycTaxiTrip {
  trip_id: string;
  vendor_id: string;
  tpep_pickup_datetime: string;
  tpep_dropoff_datetime: string;
  passenger_count: number | null;
  trip_distance: number;
  pu_location_id: number;
  do_location_id: number;
  fare_amount: number;
  total_amount: number;
}

interface NycZone {
  borough: string;
  zone: string;
  service_zone: string;
  lat: number;
  lon: number;
}

function loadTrips(): NycTaxiTrip[] {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "nyc-taxi-trips.json"), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[nyc-taxi] could not load bundled trips:", e);
    return [];
  }
}

function loadZones(): Record<number, NycZone> {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "nyc-taxi-zones.json"), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function timestampToSec(ts: string): number {
  // handles both "2024-01-01T00:57:55" and "2024-01-01 00:57:55"
  const m = ts.match(/[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

// Convert NYC taxi trips → ObservedMovement (with observedCapacity from passenger_count)
function tripsToMovements(trips: NycTaxiTrip[], zones: Record<number, NycZone>): ObservedMovement[] {
  return trips
    .filter((t) => t.pu_location_id && t.do_location_id && zones[t.pu_location_id] && zones[t.do_location_id])
    .map((t) => {
      const puZone = zones[t.pu_location_id];
      const doZone = zones[t.do_location_id];
      const pLat = puZone.lat, pLon = puZone.lon;
      const dLat = doZone.lat, dLon = doZone.lon;
      const origin = projectToKm(pLat, pLon, NYC_CENTER_LAT, NYC_CENTER_LON);
      const destination = projectToKm(dLat, dLon, NYC_CENTER_LAT, NYC_CENTER_LON);
      const departureSec = timestampToSec(t.tpep_pickup_datetime);
      const arrivalSec = timestampToSec(t.tpep_dropoff_datetime);
      // OBSERVED capacity: passenger_count tells us occupancy
      // If passenger_count=1, the taxi had 3 spare seats (4-seat vehicle)
      // If passenger_count=4, 0 spare seats
      // This is the key Tier B evidence — not inferred!
      return {
        id: t.trip_id,
        origin: origin as any,
        destination: destination as any,
        originName: `${puZone.zone}, ${puZone.borough}`,
        destName: `${doZone.zone}, ${doZone.borough}`,
        departureSec,
        arrivalSec,
        path: [{ x: origin.x, y: origin.y }, { x: destination.x, y: destination.y }],
        mode: "drive" as const,
        observedCapacity: t.passenger_count, // OBSERVED: the actual passenger count
        source: NYC_TAXI_SOURCE,
        anonymized: true,
      };
    })
    .filter((m) => m.departureSec < m.arrivalSec && m.arrivalSec - m.departureSec < 7200);
}

// Build NpdMovement records with evidence classification
export function buildNycNpdMovements(): NpdMovement[] {
  const trips = loadTrips();
  const zones = loadZones();
  const movements = tripsToMovements(trips, zones);
  return movements.map((m) => ({
    id: m.id,
    origin: m.origin,
    destination: m.destination,
    originName: m.originName,
    destName: m.destName,
    departureSec: m.departureSec,
    arrivalSec: m.arrivalSec,
    mode: m.mode,
    vehicleType: { value: "taxi", level: "observed", rationale: "NYC TLC yellow taxi data — vehicle type is known" },
    observedOccupancy: {
      value: m.observedCapacity,
      level: m.observedCapacity != null ? "observed" : "unknown",
      rationale: m.observedCapacity != null
        ? "passenger_count field in NYC TLC data — directly observed"
        : "passenger_count is null in this record",
    },
    source: NYC_TAXI_SOURCE,
    anonymized: true,
  }));
}

export class NycTaxiProvider implements TransportationDataProvider {
  readonly id = "nyc-taxi-real";
  readonly dataSource = NYC_TAXI_SOURCE;
  private cachedTrips: NycTaxiTrip[] | null = null;
  private cachedZones: Record<number, NycZone> | null = null;
  private cachedNodes: GeographicNode[] | null = null;
  private fixtureFallback: FixtureAccraProvider;

  constructor(movementSeed = 42, movementDensity = 1.0) {
    this.fixtureFallback = new FixtureAccraProvider(movementSeed, movementDensity);
  }

  private getTrips(): NycTaxiTrip[] {
    if (this.cachedTrips) return this.cachedTrips;
    this.cachedTrips = loadTrips();
    return this.cachedTrips;
  }

  private getZones(): Record<number, NycZone> {
    if (this.cachedZones) return this.cachedZones;
    this.cachedZones = loadZones();
    return this.cachedZones;
  }

  // Build geographic nodes from taxi zone centroids
  getGeographicNodesSync(): GeographicNode[] {
    if (this.cachedNodes) return this.cachedNodes;
    const zones = this.getZones();
    const nodes: GeographicNode[] = [];
    for (const [zid, z] of Object.entries(zones)) {
      const { x, y } = projectToKm(z.lat, z.lon, NYC_CENTER_LAT, NYC_CENTER_LON);
      nodes.push({
        id: `NYC-Z${zid}`,
        lat: z.lat, lon: z.lon, x, y,
        name: `${z.zone}, ${z.borough}`,
        kind: "poi",
      });
    }
    this.cachedNodes = nodes;
    return nodes;
  }

  getNetworkEdgesSync(): NetworkEdge[] {
    // build edges between zones in the same borough (coarse)
    const nodes = this.getGeographicNodesSync();
    const edges: NetworkEdge[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const km = haversineKm({ lat: nodes[i].lat, lon: nodes[i].lon }, { lat: nodes[j].lat, lon: nodes[j].lon });
        if (km < 8) {
          edges.push({
            id: `E-${nodes[i].id}-${nodes[j].id}`,
            from: nodes[i].id, to: nodes[j].id,
            distanceKm: km,
            walkTimeMin: Math.max(1, Math.round((km / 5) * 60)),
            driveTimeMin: Math.max(1, Math.round((km / 30) * 60)),
            modes: ["walk", "drive"],
          });
        }
      }
    }
    return edges;
  }

  getObservedMovementsSync(fromSec: number, toSec: number): ObservedMovement[] {
    const trips = this.getTrips();
    const zones = this.getZones();
    const movements = tripsToMovements(trips, zones);
    return movements.filter((m) => m.departureSec >= fromSec && m.departureSec <= toSec);
  }

  getTransitFeedSync(): TransitFeed { return this.fixtureFallback.getTransitFeedSync(); }
  getPilotGeographySync(): PilotGeography { return PILOT_NYC; }
  getTransitDeparturesSync(stopId: string, fromSec: number, toSec: number): TransitDeparture[] {
    return this.fixtureFallback.getTransitDeparturesSync(stopId, fromSec, toSec);
  }
  getRoadConditionsSync(): RoadCondition[] { return []; }
  getSupplyObservationsSync(): SupplyObservation[] { return []; }

  async getGeographicNodes(): Promise<GeographicNode[]> { return this.getGeographicNodesSync(); }
  async getNetworkEdges(): Promise<NetworkEdge[]> { return this.getNetworkEdgesSync(); }
  async getRoadConditions(): Promise<RoadCondition[]> { return []; }
  async getTransitFeed(): Promise<TransitFeed> { return this.getTransitFeedSync(); }
  async getTransitDepartures(stopId: string, fromSec: number, toSec: number): Promise<TransitDeparture[]> {
    return this.getTransitDeparturesSync(stopId, fromSec, toSec);
  }
  async getObservedMovements(fromSec: number, toSec: number): Promise<ObservedMovement[]> {
    return this.getObservedMovementsSync(fromSec, toSec);
  }
  async getSupplyObservations(): Promise<SupplyObservation[]> { return []; }
  async getPilotGeography(): Promise<PilotGeography> { return PILOT_NYC; }

  async ensureLoaded(): Promise<void> {
    // data is bundled — no network fetch needed
    this.getTrips();
    this.getZones();
    this.getGeographicNodesSync();
  }
}

export { PILOT_NYC, NYC_TAXI_SOURCE, NYC_OSM_SOURCE, loadTrips as loadNycTrips, loadZones as loadNycZones, tripsToMovements as nycTripsToMovements };
