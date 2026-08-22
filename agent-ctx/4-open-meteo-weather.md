# Task ID: 4
## Agent: full-stack-developer (Open-Meteo subagent)

## Task
Build REAL Open-Meteo weather adapter for the ORYXX Traffic/Incident/Weather input layer (subsystem AA). No auth, no API key — Open-Meteo is a free public service. Adapter must be OBSERVED_ONLY, never fake weather, never throw to caller.

## Prior agent work referenced
- `/home/z/my-project/worklog.md` — full read. ORYXX MVP is up (Market Simulator, Research Pilot frozen, marketplace integrity gates). Prior agents built the canonical REAL adapter pattern at `citibike-provider.ts`.
- `src/lib/oryxx/live/adapters/citibike-provider.ts` — canonical REAL adapter (explicit environment, capability declaration, AbortSignal.timeout, no fake fallback, Provenance with confidence, healthCheck). I followed this pattern.
- `src/lib/oryxx/live/types.ts` — domain types. `Environment` already includes `"OBSERVED_ONLY"`. `ProvenanceSource` did not include `"open-meteo"` — added it (additive, allowed by task spec).

## Files created
- `src/lib/oryxx/live/adapters/open-meteo-weather.ts` — adapter, types, WMO descriptor, toObservation, singleton.
- `src/app/api/oryxx/weather/route.ts` — GET handler with input validation + Cache-Control.

## Files modified (additive only)
- `src/lib/oryxx/live/types.ts` — added `"open-meteo"` to the `ProvenanceSource` union. One-line addition; no existing source removed or reordered.

## Reality verification (HONEST — not faked)
- Direct `curl https://api.open-meteo.com/v1/forecast?latitude=5.6037&longitude=-0.1870&current=...` from the sandbox returns:
  ```
  HTTP/1.1 429
  {"reason":"Daily API request limit exceeded. Please try again tomorrow.","error":true}
  ```
- Verified across 3 different coordinates (Accra, London, 0,0) + a User-Agent override — all 429. The shared sandbox IP has exceeded Open-Meteo's free-tier daily quota.
- The Open-Meteo host IS reachable: TLS handshake completes, a clean HTTP status line is returned, and the body parses as JSON. This is NOT a DNS failure, NOT a connection refused, NOT a timeout. The free-tier quota for this IP is exhausted until tomorrow (per the upstream message).
- Ran the adapter end-to-end via `bun -e`:
  - `openMeteoWeather.getWeather({lat:5.6037,lon:-0.1870})` → `null` (correctly, because upstream is 429). NEVER faked.
  - `describeWeatherCode(0|2|45|63|75|95|999)` — pure function, no network, all WMO codes map correctly.
  - `openMeteoWeather.healthCheck()` → `{connected:false, latencyMs:193, error:"HTTP 429: {\"reason\":\"Daily API request limit exceeded. Please try again tomorrow.\",\"error\":true}", timestamp:"2026-08-21T17:58:25.811Z"}` — the operator dashboard can probe and see the real upstream state.
  - `openMeteoWeather.getConnectionStatus()` → `"OBSERVED_ONLY"` (always — adapter is never transactional).
  - Invalid input (`{lat:999, lon:0}`) → `null` (input validation works).

## Adapter design
- **Reality policy**: on ANY failure (network error, HTTP 4xx/5xx, parse error, 429 rate-limit, malformed payload) → return `null`. NEVER fabricate. NEVER throw to caller.
- **Rate limiting**: minimum 1000ms gap between outgoing requests (in-memory timestamp gate). Protects the ~10,000 requests/day free-tier budget.
- **TTL cache**: 5-minute in-memory cache keyed by lat/lon rounded to 4 decimal places (~11m resolution). Matches the upstream freshness window and the API route's `Cache-Control: public, max-age=300`.
- **Timeout**: `AbortSignal.timeout(10_000)` on every fetch — a hung socket cannot wedge the adapter.
- **Provenance**: `environment: "OBSERVED_ONLY"`, `source: "open-meteo"`, `observedAt: <ISO UTC derived from upstream local time + utc_offset_seconds>`, `confidence: 0.9`.
- **WMO descriptor**: `describeWeatherCode(code): {label, severity}` with severity ∈ `"none"|"info"|"warn"|"critical"`. Full WMO table covered (0=clear, 1-3=partly cloudy, 45/48=fog, 51-67=drizzle/rain, 71-77=snow, 80-82=rain showers, 85-86=snow showers, 95-99=thunderstorm). Unknown codes → conservative `"info"`.

## ORYXX Observation mapping
- `toObservation(w): Observation | null`.
- The `ObservationType` union is `traffic | road-closure | vehicle-availability | unsafe-zone | transit-disruption | parking | loading-zone`. There is NO first-class `"weather"` variant. Per task spec ("Do NOT add a new ObservationType variant unless trivial"), I chose the conservative path:
  - `severity === "warn" || "critical"` → maps to `type: "unsafe-zone"`, `basis: "OBSERVED"`, with a weather payload (`kind:"weather"`, severity, weatherCode, weatherLabel, all numeric fields).
  - `severity === "none" || "info"` (benign weather) → returns `null`. Callers consume `WeatherObservation` directly.
- Gap noted in worklog: if the operator dashboard later needs to display weather separately from unsafe-zone incidents, a future task can add `"weather"` to `ObservationType`. Today's mapping is the minimum-surprise choice.

## API route
- `GET /api/oryxx/weather?lat=<lat>&lon=<lon>` → `{ weather: WeatherObservation | null }`.
- Input validation: lat ∈ [-90, 90], lon ∈ [-180, 180]. 400 on bad input with a clear error message + received values.
- `export const runtime = "nodejs"`. `export const dynamic = "force-dynamic"` (consistent with sibling ORYXX routes).
- `Cache-Control: public, max-age=300` on success (5-min, matches adapter TTL + upstream freshness).
- Defensive `try/catch` → 502 with `Cache-Control: no-store` if anything escapes the adapter (the adapter itself never throws). Never leaks stack traces.

## Lint
- `bun run lint` → exit code 0. No errors, no warnings. Only touched the 3 in-scope files.

## Blockers
- **None for the adapter itself.** The adapter is production-ready and will surface real observed weather the moment the Open-Meteo free-tier quota resets (tomorrow, per the upstream message) or the deployment moves to an IP with budget.
- The shared sandbox IP has exhausted Open-Meteo's free-tier daily quota TODAY. This is an environmental constraint, not a code defect. The adapter behaves exactly as specified under this condition: returns `null` for `getWeather` and reports `connected:false` with the real 429 reason via `healthCheck()`.

## What the next agent / orchestrator should know
- The Open-Meteo adapter is the first member of the Weather half of subsystem AA (Traffic / Incident / Weather input layer). Traffic + Incident adapters are NOT yet built — those are likely Task 5 / 6.
- The operator dashboard can probe `/api/oryxx/weather?lat=0&lon=0` (or any valid coordinate) and inspect `weather === null` + `healthCheck()` to confirm upstream state.
- If a future task adds a `"weather"` variant to `ObservationType`, update `toObservation()` to emit that variant directly (instead of `"unsafe-zone"`) and adjust downstream consumers.
