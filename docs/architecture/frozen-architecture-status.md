# ORYXX — Frozen Architecture Implementation Matrix

> **Source of truth for "what actually exists" vs. "what the frozen architecture requires".**
> Audited against the actual committed tree on `origin/main`. Each row reflects what is
> **committed to GitHub**, not local working-tree prototypes. This document separates
> **IMPLEMENTED** from **REAL**. "Implemented" means code exists. **REAL** means the code
> reaches a live external system with real data and no simulation fallback hiding behind it.

**Current HEAD**: `69f0710` on `main` (8 incremental commits past the audit baseline `0869b83`).
**Audited by**: principal orchestrator (first-hand file reads + remote `git cat-file` verification).

## Revision history
- `0869b83` — initial audit baseline (pre product-completion). Only Citi Bike was REAL.
- `69f0710` — Tier 1 real data adapters (OSM/OSRM/Open-Meteo/MBTA GTFS), real solver bridge
  (SLICE 1), health endpoint, product UI consolidation, and this matrix committed.

## Legend

- **IMPLEMENTED** — code exists and is exercised by tests / a route.
- **PARTIAL** — code exists but covers only part of the capability.
- **SANDBOX** — code exists but only operates in a synthetic, in-process sandbox.
- **SIMULATED** — code produces data via a deterministic simulator, not a real source.
- **OBSERVED_ONLY** — code reads a real external system but cannot transact against it.
- **NOT_CONNECTED** — adapter/interface exists but no live provider is wired.
- **NOT_IMPLEMENTED** — no code.

## Environment / boundary summary (at HEAD `69f0710`)

| Boundary | Count of subsystems |
|---|---|
| REAL (live external system, real data) | 5 (Citi Bike observation, OSM Nominatim geocoding, OSRM routing, MBTA GTFS schedules, Open-Meteo weather) |
| OBSERVED_ONLY | 5 (the above — all observe real data, none can transact) |
| SANDBOX (in-process, transactional but not real) | marketplace spine, ledger, payments, sandbox-provider |
| SIMULATED | world graph (legacy synthetic solver), synthetic market experiments |
| FIXTURE | fixture-provider, fixture-accra, nyc/chicago taxi datasets |
| NOT_CONNECTED | rideshare, taxi, freight transactional providers |
| NOT_IMPLEMENTED | notifications, webhooks, jobs, civic points, leaderboards, calendar persistence, continuous re-optimization engine, operator recovery |

> **Note on the Open-Meteo adapter:** the adapter is production-ready and REAL, but the
> shared sandbox IP may hit Open-Meteo's free-tier daily quota (HTTP 429). When that
> happens, `getWeather()` returns `null` and `healthCheck()` reports the real 429 reason.
> No weather data is ever fabricated. This is a quota constraint, not a code defect.

---

## A–AT capability matrix

| # | Architecture capability (frozen) | Current code (file) | Status | Real integration | Production-readiness | What is required to finish it |
|---|---|---|---|---|---|---|
| A | **Intent Layer** | `src/lib/oryxx/parse.ts`, `src/app/api/oryxx/solve/route.ts` | IMPLEMENTED | LLM (z-ai-web-dev-sdk) is real; heuristic fallback deterministic | Production-ready for parsing | Nothing for parsing. (Objective weighting UI is thin.) |
| B | **Transportation Event Model** | `src/lib/oryxx/types.ts` (`TransportationEvent`), `src/lib/oryxx/live/types.ts` | IMPLEMENTED | n/a (pure type) | Production-ready | Add `dependencies`, `priority` enum, `riskTolerance` already present. Consider unifying the two `TransportationDemand` shapes (market vs live). |
| C | **Global Transportation Graph** | `src/lib/oryxx/live/graph/transport-graph.ts` (34KB, provenance-bearing nodes/edges, haversine, path-finding) | PARTIAL | NOT_CONNECTED — graph exists but is **empty at runtime**; no OSM/GTFS loader populates it | Not production-ready | Build OSM + GTFS ingestion loaders that populate the graph with real nodes/edges. |
| D | **Supply Graph** | `src/lib/oryxx/live/types.ts` (`TransportationSupply`), `prisma/schema.prisma` (`TransportationSupply`) | IMPLEMENTED | 1 OBSERVED_ONLY provider (Citi Bike) populates it | Sandbox-ready | Add real micromobility + transit + taxi supply adapters. |
| E | **Demand Graph** | `src/lib/oryxx/live/types.ts` (`TransportationDemand`), `prisma/schema.prisma` (`TransportationDemand`) | IMPLEMENTED | n/a (user-originated) | Sandbox-ready | Expose demand-create API; today demand is created inside marketplace route only. |
| F | **Opportunity Graph** | `src/lib/oryxx/live/engine/opportunity-engine.ts` (780 LOC, haversine, detour, 4 "why" strings) | IMPLEMENTED | Operates on whatever supply is discovered | Sandbox-ready | Connect real supply so opportunities reflect real inventory. |
| G | **Routing / Optimization Engine** | `src/lib/oryxx/solver.ts` (synthetic, deterministic), `src/lib/oryxx/live/solver-real.ts` (REAL bridge), `src/app/api/oryxx/solve-real/route.ts` | IMPLEMENTED | REAL via `solver-real.ts` (OSRM travel times); legacy `solver.ts` remains SIMULATED | Production-ready for REAL routing; synthetic retained as fallback | Populate the transport graph from OSM/GTFS so graph-based path-finding is also REAL (currently solver-real calls OSRM directly). |
| H | **Multimodal Routing** | `src/lib/oryxx/live/solver-real.ts` (walk/bike/drive via OSRM + Citi Bike micromobility + GTFS transit), `src/lib/oryxx/market/strategies/multimodal.ts` | IMPLEMENTED | REAL walk/bike/drive travel times (OSRM) + REAL GTFS schedules + REAL Citi Bike observation | Production-ready for observed multimodal | Real transit real-time (GTFS-RT) for live schedule deviation. |
| I | **Market Clearing** | `src/lib/oryxx/live/engine/market-clearing.ts` | IMPLEMENTED | SANDBOX | Sandbox-ready | Real supply clearing once a real transactional provider exists. |
| J | **Negotiation** | `src/lib/oryxx/live/engine/negotiation.ts`, `Negotiation` type | IMPLEMENTED | SANDBOX | Sandbox-ready | Wire negotiation rounds into marketplace route (currently offer is fixed-price). |
| K | **Pricing** | `src/lib/oryxx/live/engine/pricing.ts`, `src/lib/oryxx/market/canonical/pricing.ts` | IMPLEMENTED | SANDBOX (modelled pricing) | Sandbox-ready | Real provider quote API for live pricing. |
| L | **Reservation** | `prisma/schema.prisma` (`TransportationSupply.status` AVAILABLE→RESERVED→COMMITTED), marketplace route enforces atomically | IMPLEMENTED | SANDBOX | Sandbox-ready | Real provider reservation API. |
| M | **Execution** | `src/lib/oryxx/live/engine/execution-engine.ts`, `TransportationExecution` model, state machine | IMPLEMENTED | SANDBOX | Sandbox-ready | Real provider dispatch + completion verification. |
| N | **Settlement** | `prisma/schema.prisma` (`Settlement`), `src/lib/oryxx/live/ledger/money-ledger.ts` | IMPLEMENTED | SANDBOX (ledger-only, no real PSP) | Sandbox-ready | Real PSP (Stripe/etc.) for capture/refund. |
| O | **Provider Adapter System** | `src/lib/oryxx/live/adapters/provider-registry.ts` (clean capability-discovery interface), adapters: `citibike-provider.ts`, `sandbox-provider.ts`, `fixture-provider.ts` | IMPLEMENTED | 1 real (OBSERVED_ONLY) + 2 sandbox/fixture | Production-ready as a framework | Add 1 transit + 1 taxi/fleet + 1 rideshare + 1 freight adapter. |
| P | **Availability Broadcast** | `src/lib/oryxx/live/engine/availability-broadcast.ts`, `AvailabilityBroadcast` model | IMPLEMENTED | SANDBOX | Sandbox-ready | Real driver broadcast ingestion. |
| Q | **Carpooling** | `AvailabilityBroadcast` + `OpportunityEngine` detour logic | PARTIAL | SANDBOX | Sandbox-ready | Driver mobile surface to broadcast availability. |
| R | **Latent / NPD Supply** | `AvailabilityBroadcast.status` POTENTIAL→OFFERED→RESERVED→COMMITTED, `isCommitted` flag | IMPLEMENTED | SANDBOX | Sandbox-ready | Real driver app to emit POTENTIAL broadcasts. |
| S | **Driver Agents** | `src/lib/oryxx/live/agents/agent-framework.ts` (808 LOC, L0-L5, earnings objective) | IMPLEMENTED | SANDBOX | Sandbox-ready | Driver-facing UI to configure agent + broadcast. |
| T | **Rider Agents** | same framework, `role: "rider"` | IMPLEMENTED | SANDBOX | Sandbox-ready | Rider-facing UI to configure agent. |
| U | **Shipper / Freight Agents** | same framework, `role: "shipper"` | PARTIAL | SANDBOX | Sandbox-ready | Freight object model + shipper UI. |
| V | **Personal Driver Relationships** | — | NOT_IMPLEMENTED | n/a | Not started | New `PersonalDriverSubscription` model + matching. |
| W | **Reverse Auctions** | `src/lib/oryxx/live/engine/auction.ts`, `Auction` type | IMPLEMENTED | SANDBOX | Sandbox-ready | Wire auctions into marketplace route. |
| X | **Driver / Rider Haggling** | `Negotiation` type `bounded-bargaining` | PARTIAL | SANDBOX | Sandbox-ready | Counteroffer API + UI. |
| Y | **Calendar / Future Transport Events** | `Plan.watchEstimate`, `FlexibilityOffer` `wait_watch` | PARTIAL | SIMULATED | Not production-ready | Persist `TransportationCalendarEvent` + `OpportunityWatch`; re-optimization job. |
| Z | **Continuous Re-Optimization** | `mini-services/oryxx-optimizer/` (socket.io), `src/app/api/oryxx/stream/route.ts`, `OptimizationEvent` type | PARTIAL | SIMULATED (emits synthetic events) | Not production-ready | Real event sources (provider price/availability/traffic/weather) → recompute → notify. |
| AA | **Traffic / Incident / Weather Inputs** | `src/lib/oryxx/live/adapters/open-meteo-weather.ts`, `src/app/api/oryxx/weather/route.ts` | IMPLEMENTED | REAL weather (Open-Meteo, OBSERVED_ONLY); traffic/incident feeds NOT_CONNECTED | Weather production-ready; traffic/incident not started | Traffic/incident feed adapters (511 / Here / TomTom). |
| AB | **Public Data Ingestion** | `data/*.json` (NYC TLC, Chicago taxi, FHV — real archived datasets); `src/lib/oryxx/real/providers/*` | PARTIAL | REAL for archived TLC data (offline analysis); NOT_CONNECTED for live feeds | Research-ready | Live GTFS-RT, live traffic, live weather connectors. |
| AC | **Map / Geospatial Layer** | `src/lib/oryxx/live/adapters/osm-geocoding.ts` (REAL geocoding), `src/lib/oryxx/live/adapters/osrm-routing.ts` (REAL routing), `transport-graph.ts` (empty singleton); no map tile UI | IMPLEMENTED | REAL geocoding (OSM Nominatim) + REAL routing (OSRM); graph singleton still empty; no tile rendering | Geocoding/routing production-ready; graph + tile UI not started | Populate the transport-graph singleton from OSM/GTFS; add map tile rendering. |
| AD | **Transit / GTFS / GTFS-RT** | `src/lib/oryxx/live/adapters/gtfs-transit.ts` (MBTA GTFS static, 9630 stops), `src/app/api/oryxx/transit/route.ts` | IMPLEMENTED | REAL GTFS static (MBTA Boston, OBSERVED_ONLY — schedule-only); GTFS-RT NOT_CONNECTED | Static production-ready; real-time not started | GTFS-RT protobuf adapter for live schedule deviation. |
| AE | **Fleet Management** | — | NOT_IMPLEMENTED | n/a | Not started | Fleet model + fleet operator UI. |
| AF | **Freight / Trucking** | `TransportObject.kind: cargo/pallet/container`, `vehicleRequirements` | PARTIAL | SANDBOX | Sandbox-ready | Shipment, cargo, hazmat, multi-stop route models. |
| AG | **Container / Cargo Movement** | `ObjectKind` includes `container` | PARTIAL | SANDBOX | Sandbox-ready | Container tracking + transfer/handoff. |
| AH | **Civic Contribution System** | `CivicContribution` type in `live/types.ts` | PARTIAL | NOT_IMPLEMENTED (type only, no API/UI) | Not started | API + UI + reputation. **Must remain non-monetary.** |
| AI | **Driver Leaderboards** | — | NOT_IMPLEMENTED | n/a | Not started | Leaderboard model + query + UI. |
| AJ | **User Accounts / Auth** | `src/lib/auth/*`, NextAuth Credentials, `User` + `Waitlist` models, demo accounts | IMPLEMENTED | REAL (NextAuth) | Production-ready for credentials flow | OAuth providers, MFA, email verification. |
| AK | **Payments / Wallet / Ledger** | `prisma/schema.prisma` (`MoneyAccount`, `LedgerEntry`, `PaymentIntent`, `Settlement`), `src/lib/oryxx/live/ledger/money-ledger.ts` | IMPLEMENTED | SANDBOX (ledger-only) | Sandbox-ready | Real PSP integration (Stripe). **Do NOT activate real payments until credentialed.** |
| AL | **Trust / Safety** | `User.status`, `ExperimentEnrollment.providerVerified`, marketplace env isolation | PARTIAL | SANDBOX | Not production-ready | Identity verification, incident reporting, trip sharing, emergency controls. |
| AM | **Notifications** | — | NOT_IMPLEMENTED | n/a | Not started | In-app + email + push/SMS abstraction. |
| AN | **Audit / Observability** | `MarketplaceEvent` model, `ExperimentEvent` hash chain (research) | PARTIAL | SANDBOX | Not production-ready | Structured logs, request/trace IDs, operator visibility. |
| AO | **Admin / Operations** | `WaitlistAdmin`, `ResearchOperatorDashboard` components | PARTIAL | SANDBOX | Not production-ready | Operator dashboard for providers/payments/executions/health. |
| AP | **API / Webhooks** | API routes under `src/app/api/oryxx/*` | PARTIAL | n/a | Not production-ready | Webhook ingestion + signature verification + idempotent processing. |
| AQ | **Data Pipelines** | `data/*.json` loaded by `real/providers/*` | PARTIAL | REAL for archived data | Research-ready | Live ingestion connectors + ETL. |
| AR | **Analytics** | `market/metrics.ts`, `market/statistics.ts` | PARTIAL | SIMULATED | Not production-ready | Real event analytics + dashboards. |
| AS | **Mobile / Responsive Product** | `page.tsx` uses responsive classes; no PWA | PARTIAL | n/a | Partial | PWA manifest, offline states. |
| AT | **Globalization / Multi-Country** | `MoneyAccount.currency`, `world.ts` "globally-flavored hubs", no real country config | PARTIAL | NOT_CONNECTED | Not production-ready | Country config (currency/tz/units/compliance). |

---

## Vertical slices (Section 41) — current status

| Slice | Required path | Status | Blocker |
|---|---|---|---|
| 1 | intent → geocoding → routing → route result | **REAL (COMMITTED)** — `solver-real.ts` resolves O/D via OSM Nominatim + routes via OSRM. Distance/time REAL; cost/emissions MODELLED + labelled. | None for SLICE 1. Populate transport-graph singleton for graph-based path-finding (optional). |
| 2 | intent → real transit supply → multimodal route | **PARTIAL (COMMITTED)** — GTFS static transit plans emitted by `solver-real.ts` (REAL schedules); but transit legs use modelled durations. | GTFS-RT for live schedule deviation. |
| 3 | intent → real observed supply → opportunity | **PARTIAL (COMMITTED)** — Citi Bike observed supply feeds `solver-real.ts` near NYC; opportunity engine still operates on sandbox supply. | Bridge real observed supply into the opportunity engine. |
| 4 | intent → real provider → quote → offer → accept → execute → complete → settle | **BLOCKED** — no real transactional provider | Real provider with transactional API (Tier 2) |
| 5 | future event → calendar → watch → supply change → re-opt → notify | **BLOCKED** — no calendar persistence, no jobs, no notifications | Calendar model + jobs + notifications |
| 6 | driver → availability → match → accept → execute → earnings | **SANDBOX** — agent framework + sandbox-provider only | Real driver app |
| 7 | freight → shipment → capacity → route → transfer → delivery | **BLOCKED** — no freight object model beyond `ObjectKind` | Freight models |

---

## Stop-conditions check (Section 43)

A subsystem is production-ready ONLY when ALL of: real deps work, failure paths handled, security enforced, state transitions durable, idempotency exists, observability exists, deployment documented, operator recovery exists, tests cover core paths.

| Subsystem | Real deps | Failure paths | Security | Durable state | Idempotency | Observability | Deploy docs | Operator recovery | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Intent parsing | ✓ (LLM) | ✓ (heuristic) | ✓ (auth+rate limit) | n/a | n/a | ✗ | ✗ | n/a | ✓ |
| Marketplace spine | ✗ (sandbox) | ✓ | ✓ | ✓ (Prisma) | ✓ (claim-before-call) | ✗ | ✗ | ✗ | ✓ |
| Ledger | ✗ (sandbox) | ✓ | ✓ | ✓ | ✓ (idempotencyKey) | ✗ | ✗ | ✗ | ✓ |
| Provider adapters | 5 OBSERVED_ONLY (Citi Bike, OSM, OSRM, Open-Meteo, GTFS) | ✓ | ✓ | ✓ | ✓ (health endpoint) | ✗ | ✗ | ✓ (via curl) |
| Research instrument | n/a (frozen) | ✓ | ✓ | ✓ | ✓ | ✓ (hash chain) | ✓ (checklist) | ✓ | ✓ |

**Observability and deploy docs are now partially present** (health endpoint + this matrix), but **operator recovery** and **deployment runbooks** are still not written. The marketplace spine remains sandbox-complete, blocked on a real transactional provider.

---

## Exact next engineering priorities (ordered, at HEAD `69f0710`)

**Completed in this pass (committed):**
1. ~~OSM Nominatim geocoding adapter~~ ✅ committed (`405f723`)
2. ~~OSRM routing adapter~~ ✅ committed (`405f723`)
3. ~~Open-Meteo weather adapter~~ ✅ committed (`4c558fe`)
4. ~~GTFS static ingestion~~ ✅ committed (`4d13b80`)
5. ~~Bridge solver ↔ real routing (SLICE 1)~~ ✅ committed (`07068eb`)
6. ~~Health endpoint~~ ✅ committed (`3c0e2e5`)
7. ~~UI consolidation (PRODUCT vs Research/Labs)~~ ✅ committed (`c3ff738`)

**Remaining (ordered):**
1. **Populate the transport-graph singleton** from OSM/GTFS so graph-based path-finding is REAL (currently solver-real calls OSRM directly; the graph is empty).
2. **Tier 2 real transactional provider** — one rideshare OR taxi/fleet provider with a real quoting/reservation/dispatch API. Unblocks SLICE 4 + W3-M/W4-M.
3. **Notifications + jobs** — calendar persistence, opportunity watches, re-optimization job, delivery. Unblocks SLICE 5.
4. **Webhook architecture** — provider/payment/execution event ingestion, signature-verified, idempotent.
5. **Continuous re-optimization engine** — wire real event sources (price/availability/traffic/weather) into the optimizer mini-service.
6. **GTFS-RT** — live schedule deviation for transit plans.
7. **Security threat-model pass** — CSRF, tenant isolation, PII handling, webhook signatures, rate limits.
8. **Operator recovery runbook** + deployment documentation (ARCHITECTURE/PROVIDERS/OPERATIONS/SECURITY/etc.).

> Science is intentionally PAUSED. The research layer (W3-R/W4-R, preregistration, evidence definitions) is FROZEN and must not be altered. No scientific conclusions are claimed or re-claimed in this document.
