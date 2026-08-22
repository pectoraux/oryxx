# ORYXX — Frozen Architecture Implementation Matrix

> **Source of truth for "what actually exists" vs. "what the frozen architecture requires".**
> Audited against the actual working tree at HEAD `0869b83` on `main` (clean working tree).
> This document separates **IMPLEMENTED** from **REAL**. "Implemented" means code exists.
> "REAL" means the code reaches a live external system with real data and no simulation fallback hiding behind it.

**HEAD commit**: `0869b8379fcf32b1fbacd69518776854a092a9c4`
**Branch**: `main`, up to date with `origin/main`
**Audited by**: principal orchestrator (first-hand file reads, not prior reports)

## Legend

- **IMPLEMENTED** — code exists and is exercised by tests / a route.
- **PARTIAL** — code exists but covers only part of the capability.
- **SANDBOX** — code exists but only operates in a synthetic, in-process sandbox.
- **SIMULATED** — code produces data via a deterministic simulator, not a real source.
- **OBSERVED_ONLY** — code reads a real external system but cannot transact against it.
- **NOT_CONNECTED** — adapter/interface exists but no live provider is wired.
- **NOT_IMPLEMENTED** — no code.

## Environment / boundary summary

| Boundary | Count of subsystems |
|---|---|
| REAL (live external system, real data) | 1 (Citi Bike station observation) |
| OBSERVED_ONLY | 1 (Citi Bike) |
| SANDBOX (in-process, transactional but not real) | marketplace spine, ledger, payments, sandbox-provider |
| SIMULATED | world graph (solver), synthetic market experiments |
| FIXTURE | fixture-provider, fixture-accra, nyc/chicago taxi datasets |
| NOT_CONNECTED | OSM, OSRM, GTFS, weather, traffic, rideshare, taxi, transit, freight |
| NOT_IMPLEMENTED | notifications, webhooks, jobs, civic points, leaderboards, calendar persistence, continuous re-optimization engine, operator health |

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
| G | **Routing / Optimization Engine** | `src/lib/oryxx/solver.ts` (744 LOC, deterministic, multi-objective, stochastic ETA) | IMPLEMENTED | **SIMULATED** — operates on `world.ts` synthetic hubs, NOT the real transport graph | Not production-ready | Bridge solver to real graph (`transport-graph.ts`) + OSRM travel times. Keep deterministic authority. |
| H | **Multimodal Routing** | `src/lib/oryxx/solver.ts` (walk/bike/bus/train/ferry/rideshare/carpool/freight modes), `src/lib/oryxx/market/strategies/multimodal.ts` | PARTIAL | SIMULATED | Not production-ready | Real mode travel times from OSRM profiles + GTFS schedules. |
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
| AA | **Traffic / Incident / Weather Inputs** | — | NOT_IMPLEMENTED | NOT_CONNECTED | Not started | Open-Meteo + 511/traffic feed adapters. |
| AB | **Public Data Ingestion** | `data/*.json` (NYC TLC, Chicago taxi, FHV — real archived datasets); `src/lib/oryxx/real/providers/*` | PARTIAL | REAL for archived TLC data (offline analysis); NOT_CONNECTED for live feeds | Research-ready | Live GTFS-RT, live traffic, live weather connectors. |
| AC | **Map / Geospatial Layer** | `transport-graph.ts` haversine + GeoPoint; no map rendering in UI | PARTIAL | NOT_CONNECTED (no OSM tiles, no geocoding) | Not production-ready | OSM Nominatim geocoding + OSRM routing + map tile UI. |
| AD | **Transit / GTFS / GTFS-RT** | — | NOT_IMPLEMENTED | NOT_CONNECTED | Not started | GTFS static parser + GTFS-RT protobuf adapter. |
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
| 1 | intent → geocoding → routing → route result | **BLOCKED** — solver uses synthetic hubs, no geocoding | OSM Nominatim + OSRM adapters |
| 2 | intent → real transit supply → multimodal route | **BLOCKED** — no GTFS | GTFS ingestion |
| 3 | intent → real observed supply → opportunity | **PARTIAL** — Citi Bike observed supply → opportunity engine works, but solver doesn't consume it | Bridge solver ↔ opportunity engine |
| 4 | intent → real provider → quote → offer → accept → execute → complete → settle | **BLOCKED** — no real transactional provider | Real provider with transactional API |
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
| Provider adapters | 1 OBSERVED_ONLY | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ |
| Research instrument | n/a (frozen) | ✓ | ✓ | ✓ | ✓ | ✓ (hash chain) | ✓ (checklist) | ✓ | ✓ |

**No subsystem currently meets all 9 stop-conditions.** The two closest are the **research instrument** (frozen, intentionally) and the **marketplace spine** (sandbox-complete, blocked on a real provider).

---

## Exact next engineering priorities (ordered)

1. **OSM Nominatim geocoding adapter** (REAL, no auth) — unblocks SLICE 1, 2, 3, 4.
2. **OSRM routing adapter** (REAL road network, walk/bike/drive profiles) — unblocks SLICE 1, 2.
3. **Open-Meteo weather adapter** (REAL, no auth) — unblocks subsystem AA, Z.
4. **GTFS static ingestion** (REAL transit schedules) — unblocks SLICE 2, subsystem AD.
5. **Bridge solver ↔ real graph** — replace synthetic `world.ts` fallback with real coordinates + OSRM travel times while keeping deterministic authority.
6. **Health endpoints** (`/api/health/db`, `/api/health/providers`, `/api/health/graph`) — unblocks subsystem AN, AO.
7. **Operator dashboard surface** — provider health, ledger, executions, stuck states.
8. **UI consolidation** — separate PRODUCT surfaces from Research/Labs.
9. **Notifications + jobs** — unblocks SLICE 5, subsystems AM, AN, Z.
10. **Real transactional provider** (Tier 2) — unblocks SLICE 4 and W3-M/W4-M.

> Science is intentionally PAUSED. The research layer (W3-R/W4-R, preregistration, evidence definitions) is FROZEN and must not be altered. No scientific conclusions are claimed or re-claimed in this document.
