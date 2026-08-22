// ORYXX — Data-Source Registry
//
// Real-world DATA adapters (geocoding, routing, gazetteers, elevation) are
// NOT transportation providers — they cannot quote, reserve, accept, or
// execute marketplace offers. They exist to ground the solver's plans in
// real geographic reality (real coordinates, real road network distances,
// real travel times).
//
// This registry is intentionally SEPARATE from `providerRegistry` (which
// holds transportation-supply providers that participate in the marketplace).
// A real geocoder/routing API does not have a `getProviderIdentity()` shape
// and does NOT participate in offer/accept/execute lifecycle.
//
// Classification (per adapter):
//   - osmGeocoder   : OBSERVED_ONLY — OSM Nominatim
//   - osrmRouter    : OBSERVED_ONLY — OSRM demo server
//   - gtfsTransit   : OBSERVED_ONLY — GTFS static ZIP (default: MBTA feed)
//
// All adapters in this registry MUST declare:
//   - environment = "OBSERVED_ONLY"
//   - getCapabilities() / getProvenance() accessors
//   - explicit failure policy (return null / [] — never fake data)

import { osmGeocoder } from "./osm-geocoding";
import { osrmRouter } from "./osrm-routing";
import { gtfsTransit } from "./gtfs-transit";
import type { OsmGeocoderCapabilities } from "./osm-geocoding";
import type { OsrmRouterCapabilities } from "./osrm-routing";
import type { GtfsTransitCapabilities } from "./gtfs-transit";

// Re-export the singletons so callers have a single import point.
export { osmGeocoder, osrmRouter, gtfsTransit };
export type { GeocodeResult, OsmGeocoderCapabilities, OsmGeocoderProvenance } from "./osm-geocoding";
export type {
  RouteResult,
  RoutingProfile,
  OsrmRouterCapabilities,
  OsrmRouterProvenance,
} from "./osrm-routing";
export type {
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
  GtfsRoute,
  GtfsDeparture,
  GtfsFeedMeta,
  GtfsTransitCapabilities,
  GtfsTransitProvenance,
} from "./gtfs-transit";

// ═══════════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════════

export interface DataSourceEntry {
  id: string;
  kind: "geocoding" | "routing" | "transit";
  environment: "OBSERVED_ONLY";
  dataSource: string;
  coverage: string;
  lastUpdated: string | null;
  lastError: string | null;
  capabilities: OsmGeocoderCapabilities | OsrmRouterCapabilities | GtfsTransitCapabilities;
}

class DataSourceRegistry {
  private entries: DataSourceEntry[];

  constructor() {
    this.entries = [
      {
        id: "osm-geocoding",
        kind: "geocoding",
        environment: "OBSERVED_ONLY",
        dataSource: "OpenStreetMap Nominatim",
        coverage: "Global",
        get lastUpdated() {
          return osmGeocoder.getProvenance().lastUpdated;
        },
        get lastError() {
          return osmGeocoder.getProvenance().lastError;
        },
        get capabilities() {
          return osmGeocoder.getCapabilities();
        },
      },
      {
        id: "osrm-routing",
        kind: "routing",
        environment: "OBSERVED_ONLY",
        dataSource: "OSRM demo server",
        coverage: "Global road network",
        get lastUpdated() {
          return osrmRouter.getProvenance().lastUpdated;
        },
        get lastError() {
          return osrmRouter.getProvenance().lastError;
        },
        get capabilities() {
          return osrmRouter.getCapabilities();
        },
      },
      {
        id: "gtfs-transit",
        kind: "transit",
        environment: "OBSERVED_ONLY",
        dataSource: "GTFS static ZIP (default: MBTA)",
        coverage: "Coverage of the loaded GTFS feed (default: MBTA — Massachusetts, US)",
        get lastUpdated() {
          return gtfsTransit.getProvenance().lastUpdated;
        },
        get lastError() {
          return gtfsTransit.getProvenance().lastError;
        },
        get capabilities() {
          return gtfsTransit.getCapabilities();
        },
      },
    ];
  }

  list(): DataSourceEntry[] {
    return this.entries;
  }

  get(id: string): DataSourceEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
}

export const dataSourceRegistry = new DataSourceRegistry();
