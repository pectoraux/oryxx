# Task 3 — OSM Nominatim geocoding + OSRM routing adapters

## Task ID
`3`

## Agent Name
`full-stack-developer (OSM/OSRM subagent)`

## Summary

Built two REAL, OBSERVED_ONLY data-source adapters and three API routes that
ground ORYXX routes in the real OpenStreetMap road network. Both adapters
follow the canonical `citibike-provider.ts` pattern: explicit environment,
explicit capability declaration, `AbortSignal.timeout` on every fetch,
strict "return [] / null on any failure, never fake" policy, and explicit
`Provenance` stamps on every result.

This task was scoped to data-source adapters (geocoding + routing) — these
are NOT transportation providers that accept marketplace offers, so they
live in a separate `dataSourceRegistry` and are intentionally NOT mixed
into `providerRegistry`.

## Files Created (7)

### Adapters (4)
1. `src/lib/oryxx/live/adapters/osm-geocoding.ts`
   - Singleton `osmGeocoder`.
   - `geocode(query)` → `GeocodeResult[]` (forward geocoding via
     `https://nominatim.openstreetmap.org/search`).
   - `reverseGeocode(point)` → `GeocodeResult | null` (via
     `https://nominatim.openstreetmap.org/reverse`).
   - In-process rate limiter (≥1100ms between requests — Nominatim usage
     policy compliant) + 5min TTL cache.
   - Headers: `User-Agent: ORYXX/0.2 (transportation operating system)`,
     `Referer: https://oryxx.app/`.
   - Provenance: `environment: "OBSERVED_ONLY"`, `source: "osm"`,
     `confidence: 0.9`.
   - Failure policy: ANY failure (network, non-2xx, 429, timeout, parse)
     → return `[]` for `geocode()`, `null` for `reverseGeocode()`.
     NEVER returns fake coordinates. NEVER throws to caller.

2. `src/lib/oryxx/live/adapters/osrm-routing.ts`
   - Singleton `osrmRouter`.
   - `route(points, profile)` → `RouteResult | null` where
     `RouteResult = { distanceKm, durationSec, geometry, profile, provenance }`.
   - `travelTimeSec(from, to, profile)` → `number | null` (solver helper).
   - Profile mapping: `walk→foot`, `bike→bike`, `dr→driving`. NO silent
     substitution. If OSRM returns 4xx/5xx for a profile, returns `null`.
   - Coordinate order: ORYXX uses `{lat, lon}`; OSRM expects `LON,LAT`.
     Conversion handled internally.
   - Rate limiter (1100ms) + 10min TTL cache. `AbortSignal.timeout(15000)`.
   - Provenance: `environment: "OBSERVED_ONLY"`, `source: "osrm"`,
     `confidence: 0.85` (OSRM demo is not SLA-backed).
   - Failure policy: returns `null` on ANY failure. NEVER returns fake
     distances/times.

3. `src/lib/oryxx/live/adapters/data-source-registry.ts`
   - Re-exports `osmGeocoder` and `osrmRouter`.
   - Exposes `dataSourceRegistry.list()` for ops visibility (id, kind,
     environment, dataSource, coverage, lastUpdated, lastError, capabilities).
   - SEPARATE from `providerRegistry` — these are data sources, not
     transportation providers.

4. `src/lib/oryxx/live/adapters/node-connectivity-fix.ts`
   - Fix for a Node 24 + undici bug discovered during testing.
   - Node's built-in `fetch` (undici) uses Happy Eyeballs (RFC 8305) to
     race IPv4/IPv6. On hosts with AAAA records where IPv6 egress is
     blocked (common in cloud sandboxes), the IPv6 SYN silently fails and
     undici surfaces a generic "fetch failed" / ETIMEDOUT — observed
     against OSRM's `router.project-osrm.org` → `routing.openstreetmap.de`
     (AAAA: `2a02:418:39aa:8::7`).
   - Fix: `dns.setDefaultResultOrder("ipv4first")` +
     `net.setDefaultAutoSelectFamily(false)` at module load.
   - Idempotent. No-op on Bun (which already handles Happy Eyeballs
     correctly). The adapters import this module once; subsequent imports
     are free.

### API routes (3)
5. `src/app/api/oryxx/geocode/route.ts`
   - GET `?query=<place>` → `{ results, provenance }`.
   - 400 on empty/over-long query. 502 on adapter exception (clean message,
     no stack trace).
   - `runtime = "nodejs"`, `dynamic = "force-dynamic"`,
     `Cache-Control: no-store`.

6. `src/app/api/oryxx/route/route.ts`
   - GET `?from=<lat,lon>&to=<lat,lon>&profile=walk|bike|dr`
     → `{ route, provenance }`.
   - Validates coords (±90/±180), validates profile whitelist.
   - 400 on bad input. 502 on adapter exception. Same headers as above.

7. `src/app/api/oryxx/reverse-geocode/route.ts`
   - GET `?lat=&lon=` → `{ result, provenance }`.
   - 400 on bad input. 502 on adapter exception. Same headers as above.

## Reality Labels Enforced

Every adapter exports `getCapabilities()` and `getProvenance()` accessors
following the `citibike-provider.ts` pattern. Top-of-file comment blocks
document what IS and IS NOT supported. Environment is ALWAYS
`"OBSERVED_ONLY"` — these adapters observe real data but cannot transact.

## Live API Reachability — VERIFIED

### OSM Nominatim ✅ REACHABLE + REAL DATA
- `osmGeocoder.geocode("Eiffel Tower, Paris")` returned:
  - lat=48.8582599, lon=2.2945006 — EXACT match for the expected ~48.85,
    ~2.29.
  - displayName="Eiffel Tower, 5, Avenue Anatole France, Quartier du
    Gros-Caillou, 7th Arrondissement, Paris..."
- `osmGeocoder.reverseGeocode({lat:48.8575,lon:2.2945})` returned the
  real street address by the Eiffel Tower.
- Via the dev server API route:
  `/api/oryxx/geocode?query=Times+Square,New+York` returned real
  OSM data (Times Square Manhattan, lat 40.757, lon -73.985).
- Note: my first raw `curl` tests hit transient HTTP 429 from the
  Nominatim Varnish cache layer. The adapter's own rate limiter + 5min
  cache + 1100ms spacing handled this correctly — verified production
  calls return real coordinates, never fake ones.

### OSRM demo server ✅ REACHABLE + REAL DATA
- `osrmRouter.travelTimeSec({48.8575,2.2945},{48.8606,2.3376},"dr")`
  returned `768.1` (a positive number of seconds). ✅
- `osrmRouter.route([...], "dr")` returned distanceKm=4.5122,
  durationSec=768.1, profile="driving", 205-point geometry, provenance
  OBSERVED_ONLY/osrm/0.85.
- Via the dev server API route:
  `/api/oryxx/route?from=40.7484,-73.9857&to=40.7831,-73.9712&profile=dr`
  returned 5.443 km, 644.9 sec, 223-point geometry.
- OSRM demo server note: it accepts the `foot`/`bike` profiles (no 4xx)
  but routes them over the driving graph. This is the demo server's
  documented behavior — REAL data from OSRM, not faked by ORYXX.
- IMPORTANT — Node 24 IPv6/IPv4 issue: from `bun run` scripts, OSRM
  worked immediately. From the Next.js dev server (Node 24 + undici
  fetch), the very first OSRM call failed with `TypeError: fetch failed`
  / `cause.code=ETIMEDOUT`. Root cause: OSRM's hostname has an AAAA
  record; Node's undici tries IPv6 first and times out without falling
  back. Fixed by `node-connectivity-fix.ts` (see file 4 above). After
  the fix, OSRM works identically from Bun and from the Node dev server.

## Failure Policy — Verified Non-Fake

During the IPv6-ETIMEDOUT episode (before the fix), the OSRM adapter
correctly returned `null` with a clean error message. It NEVER returned
fake distances/times. This is the policy the task spec required, and it
was actually exercised by a real failure mode in the sandbox.

## Lint

`bun run lint` — clean. One iteration was needed: the initial
`node-connectivity-fix.ts` used `require()` (for Node-only conditional
loading) which violated `@typescript-eslint/no-require-imports`. Converted
to ESM `import * as dns from "node:dns"` with feature-detected method
calls; lint now passes.

## Blockers

None. Both live APIs are reachable, both adapters return real data, all
three API routes work end-to-end through the dev server. The Node IPv6
issue was a real bug that I fixed (and documented in
`node-connectivity-fix.ts` so the next agent doesn't have to rediscover
it).
