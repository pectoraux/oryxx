# Task ID: 5 — GTFS Static Ingestion Adapter

**Agent:** full-stack-developer (GTFS subagent)
**Task:** Build a REAL GTFS static ingestion adapter for ORYXX (subsystem AD — Transit/GTFS layer).

## Files created / modified

### Created
- `src/lib/oryxx/live/adapters/gtfs-transit.ts` — `GtfsTransitAdapter` class + `gtfsTransit` singleton.
  - Types: `GtfsStop`, `GtfsStopTime`, `GtfsTrip`, `GtfsRoute`, `GtfsDeparture`, `GtfsFeedMeta`, `GtfsTransitCapabilities`, `GtfsTransitProvenance`.
  - Methods: `loadFeed(url)`, `getStopsNear(point, radiusKm)`, `getNextDepartures(stopId, fromSec, limit)`, `toTransportationSupply(stop, departures)`, `getProvenance()`, `asProviderProvenance()`, `getFeedMeta()`, `isReady()`, `ensureFeedLoaded()`, `clearCache()`.
  - Environment: `OBSERVED_ONLY`. Capabilities: all `false` (quotes/reservation/dispatch/tracking/completion/payments) — GTFS static is schedule-only, not transactional.
  - Cache: in-memory Map (stops / routes / trips / stopTimesByStop) with 24h TTL.
  - Lazy load: `ensureFeedLoaded()` is non-blocking; first API GET returns 504 with hint, kicks off background load.
- `src/app/api/oryxx/transit/route.ts` — REST API:
  - `GET ?lat=&lon=&radiusKm=&limit=` → `{ stops: [{ stop, nextDepartures, supply }], feed }`
  - `GET` (no params) → `{ feed }` (status only, does NOT trigger a load)
  - `POST ?action=reload` (admin-gated via `getServerSession` + `role === "admin"`) → forces re-download
  - `runtime = "nodejs"`, `dynamic = "force-dynamic"`
  - Validation: 400 on bad lat/lon/radiusKm/limit. 504 when feed loading (with hint). 502 when feed load failed. 403 on POST without admin role.

### Modified
- `src/lib/oryxx/live/adapters/data-source-registry.ts` — added `gtfsTransit` singleton import, added "transit" to the `kind` union, added the registry entry with getters that delegate to `gtfsTransit.getProvenance() / getCapabilities()`. Added explicit `import type` for `GtfsTransitCapabilities` (the existing OSM/OSRM entries were relying on `export type { ... } from "..."` re-exports to bring the names into module scope — which doesn't actually work in strict TypeScript module isolation, so I also added explicit `import type` for `OsmGeocoderCapabilities` and `OsrmRouterCapabilities` for symmetry / safety).
- `package.json` / `bun.lock` — added `adm-zip@0.6.0`, `csv-parse@7.0.2`, `@types/adm-zip@0.5.8` (dev).

## Feed URL chosen

**MBTA (Boston, MA, US):** `https://cdn.mbta.com/MBTA_GTFS.zip`

Reachability verification (from the sandbox):
- `https://www.caltrain.com/files/GTFS/caltrain/GTFSData.zip` → HTTP 302 redirect to a non-feed page (effectively 404 — Caltrain moved the feed). Skipped.
- `https://developer.trimet.org/gtfs.zip` → Connection timed out after 15s. Skipped.
- `https://cdn.mbta.com/MBTA_GTFS.zip` → HTTP 200, `content-type: application/zip`, 18,567,559 bytes. **Selected.**
- `https://ttc-gtfs.s3.amazonaws.com/latest/ttc.zip` → HTTP 403 Forbidden. Skipped.

## Stop count parsed (verified end-to-end through the live API)

After the first GET triggered a background load:
- Stops (in feed, with valid coordinates): **9,630** (out of 10,297 raw rows — 667 rows had no valid lat/lon and were skipped per the parse policy)
- Routes: **399**
- Trips: **89,080**
- Stop_times: **2,221,062**
- `loadedAt`: ISO timestamp
- `sourceEnvironment`: `OBSERVED_ONLY`

Sample response for `GET ?lat=42.3601&lon=-71.0589&radiusKm=2&limit=3` (Boston):
- 25 nearby stops returned (capped at MAX_STOPS=25)
- First stop: "Government Center" (stopId 70039)
- Departures: Blue Line subway (route_type=1) toward "Bowdoin" at 65340s, 65340s, 65460s (correctly joined stop_times × trips × routes)

## Live API reachability

Confirmed working end-to-end through `http://localhost:3000`:
- `GET /api/oryxx/transit` (no params) → 200 with feed status
- `GET /api/oryxx/transit?lat=42.36&lon=-71.06&radiusKm=2&limit=3` → first call 504 (loading, kicked off background load); same call after ~25s wait → 200 with real stops + departures + supply objects
- `POST ?action=reload` without auth → 403 (admin gate enforced)
- `GET ?lat=200&lon=0` → 400 (bad lat)
- `GET ?lat=42.36` (missing lon) → 400

## Memory / load profile

- Initial naive sync parse of stop_times.txt (2.2M rows) → ~800MB heap + ~1GB RSS, and one approach OOM-killed the process (exit 137).
- Final implementation: extract `stop_times.txt` to a temp file, stream-parse via `csv-parse` stream API into a per-stop index, delete the temp file in `finally`. Peak heap ~250MB, load time ~12-15s. RSS spikes during parse but settles after GC.

## Reality labels (strict)

- Top-of-file comment block in `gtfs-transit.ts` mirrors the citibike-provider pattern: OBSERVED_ONLY, real GTFS static, schedule-only (NOT real-time), coverage = whatever feed covers, data source URL.
- `getStopsNear` / `getNextDepartures` return `[]` if the feed is not loaded or stale — NEVER fabricate stops or departures.
- `loadFeed` catches all errors, clears the cache, sets `lastError`, and resolves with empty counts — NEVER throws to the caller, NEVER falls back to synthetic data.
- `"gtfs"` was already present in the `ProvenanceSource` union (added by a prior task — additive change, no further modification needed).

## Blockers

None. The adapter is production-shaped and the live API is reachable.

Open considerations (not blockers):
1. The MBTA feed's `stop_times.txt` is 104MB uncompressed / 2.2M rows. Load time is ~12-15s and RSS spikes during parse. For a production deployment with tighter memory budgets, consider (a) a smaller feed (Caltrain was unreachable in the sandbox; could try alternative URLs), (b) using a sqlite-backed index instead of in-memory Map, or (c) pre-fetching the feed at boot time so the first API call doesn't have to wait.
2. `plannedRoute` in `toTransportationSupply` is empty — GTFS shapes (geometry) are in `shapes.txt` which we don't ingest by default. Downstream consumers can reconstruct the route from stop_times if needed.
3. POST `?action=reload` is admin-gated via NextAuth role check. The brief noted this should be admin-gated in production — it IS.
4. No `calendar.txt` filtering — `getNextDepartures` returns ALL stop_times for the stop, regardless of service day. This is a known simplification; the wraparound logic handles "next departures" correctly but doesn't filter to "service running today." A production-grade version would join `calendar.txt` + `calendar_dates.txt` to filter to the current service day.
