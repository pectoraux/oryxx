// ORYXX — TransportationDataProvider interface.
//
// Every external data source (OSM, GTFS, movement datasets, commercial APIs)
// implements this interface. The Opportunity Engine consumes providers, never
// raw data. Swapping a fixture for a real feed = swapping the provider, with
// no engine changes.
//
// Future providers (Uber, Bolt, transit agencies, fleet APIs) are adapters
// that implement this interface — NOT architectural rewrites.

import type {
  GeographicNode,
  NetworkEdge,
  TransitFeed,
  TransitDeparture,
  ObservedMovement,
  SupplyObservation,
  RoadCondition,
  PilotGeography,
  DataSource,
} from "../types";

export interface TransportationDataProvider {
  readonly id: string;
  readonly dataSource: DataSource;

  // geographic road + walking graph
  getGeographicNodes(): Promise<GeographicNode[]>;
  getNetworkEdges(): Promise<NetworkEdge[]>;
  getRoadConditions(): Promise<RoadCondition[]>;

  // transit
  getTransitFeed(): Promise<TransitFeed>;
  getTransitDepartures(stopId: string, fromSec: number, toSec: number): Promise<TransitDeparture[]>;

  // movement / latent supply (LAYER A — observed only)
  getObservedMovements(fromSec: number, toSec: number): Promise<ObservedMovement[]>;

  // active/commercial supply (rideshare/fleet) — may be empty for fixture
  getSupplyObservations(loc: { lat: number; lon: number }, atSec: number): Promise<SupplyObservation[]>;

  // pilot metadata
  getPilotGeography(): Promise<PilotGeography>;
}

// Helper: convert seconds-from-midnight to HH:MM:SS
export function secToTime(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function timeToSec(hhmmss: string): number {
  const [h, m, s] = hhmmss.split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

// Haversine distance in km (for real lat/lon)
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}

// Project lat/lon to local km grid (equirectangular approximation — fine for
// a single city). Centered on the pilot's centroid.
export function projectToKm(lat: number, lon: number, centerLat: number, centerLon: number): { x: number; y: number } {
  const R = 6371;
  const x = ((lon - centerLon) * Math.PI) / 180 * R * Math.cos((centerLat * Math.PI) / 180);
  const y = ((lat - centerLat) * Math.PI) / 180 * R;
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 } as any;
}
