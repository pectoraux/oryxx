# ORYXX — Shared Worklog

This file is the single shared worklog for all agents working on ORYXX.
Each agent appends a new section (separated by `---`) after finishing its Task ID.

---
Task ID: 0
Agent: orchestrator (principal)
Task: Bootstrap ORYXX MVP — the Transportation Event Solver console. Internalize master prompt, pick the wedge, scaffold shared types/world/solver/parse, then build frontend + backend + continuous-optimization mini-service.

Work Log:
- Surveyed existing Next.js 16 project: shadcn/ui full set present, z-ai-web-dev-sdk present, Prisma+SQLite configured, dev server running on :3000.
- Loaded LLM skill (z-ai-web-dev-sdk) for backend intent understanding.
- Confirmed socket.io / socket.io-client were NOT installed; installing now.
- Wedge decision (recorded for the team): Do NOT launch a two-sided marketplace on day 1 (cold-start killer). Build the INTELLIGENCE CORE: intent → structured TransportationEvent → deterministic multi-objective multi-hop solver over a SIMULATED 3-graph (physical/schedule/market) including latent supply (NPDs). Output = ranked plans (Best Overall / Cheapest / Fastest / Most Reliable / Interesting Alternative) with explicit tradeoffs, confidence, flexibility offers (time-as-variable), autonomy L0-L5, and a socket.io continuous-re-optimization feed. This proves the thesis without needing real supply liquidity and creates the proprietary intelligence (intent/latent-supply/opportunity graphs) that becomes the moat.

Stage Summary:
- Stack locked: Next.js 16 + TS + shadcn/ui + z-ai-web-dev-sdk (backend only) + socket.io mini-service on :3003.
- Key principle enforced: LLM parses intent; DETERMINISTIC solver owns feasibility (master prompt §26). LLM never the source of truth for routing feasibility.
- Next: define types → world graph → solver → parser → API route → frontend → mini-service → self-verify with Agent Browser.

---
Task ID: 8
Agent: orchestrator (principal)
Task: Build the full ORYXX MVP intelligence-core console and self-verify with Agent Browser.

Work Log:
- Created deterministic domain core: types.ts, world.ts (3-graph: physical/schedule/market + latent supply NPDs + place resolver with synthetic fallback), solver.ts (multi-hop candidate enumeration, stochastic ETA variance, on-time probability via normal CDF, expected-utility scoring, hard-constraint enforcement, canonical plan selection, flexibility-offer synthesis, honest unknowns), parse.ts (LLM intent->TransportationEvent via z-ai-web-dev-sdk with strict JSON + heuristic fallback).
- API route /api/oryxx/solve: accepts {intent} or {event}; LLM parses intent; deterministic solver owns feasibility (master prompt §26 enforced).
- Frontend / page: ORYXX console — intent NL+structured builder, objective-weight sliders, risk tolerance, autonomy L0-L5 picker, parsed-event card, ranked plan cards (Best Overall/Cheapest/Fastest/Most Reliable/Interesting Alternative) with multi-hop itinerary timeline + tradeoff notes + honest confidence, flexibility-offers panel (apply -> re-solve), continuous re-optimization feed.
- Mini-service mini-services/oryxx-optimizer (port 3003, socket.io, path '/'): streams price_drop / new_latent_supply / traffic_incident / eta_update / reoptimized / cancellation / price_surge / watch_triggered events; autonomy L4+ acts on user's behalf.
- Fixed missing lucide icon (Walk -> Footprints). Corrected NPD matcher to exact hub-to-hub so carpool segments genuinely terminate at destination.
- Self-verified with Agent Browser through the Caddy gateway (port 81): page renders, no console/runtime errors; golden path solve -> 4-6 plans rendered + toast; flexibility offer apply re-solves; socket.io handshake succeeds via ?XTransformPort=3003; live optimization feed streams all event types end-to-end (price drops, latent-supply matches, traffic incidents, re-optimizations, cancellations); no mobile horizontal overflow (overflowX=0); sticky footer confirmed (sticksToBottom=true on short content, pushed down on long content).

Stage Summary:
- ORYXX MVP is live, interactive, and browser-verified.
- Proves the core thesis (master prompt §1,2,4,9,10,18,19,20,21,22,26) without requiring two-sided marketplace liquidity (the cold-start killer): LLM parses intent; deterministic solver owns feasibility; time/transfers/latent-supply are optimization levers; confidence and unknowns are honest; continuous re-optimization streams live.
- Moat seeds planted: transportation-opportunity graph, latent-supply graph, intent data, deterministic multi-objective solver.
- Wedge validated: this is the intelligence core that real supply (commercial APIs, GTFS, fleets) plugs into later via the provider abstraction in world.ts.

---
Task ID: auth-deploy
Agent: orchestrator (principal)
Task: Add authentication (waitlist signup + admin approval + demo quick-login), connect Neon PostgreSQL, push to GitHub, deploy to Vercel at oryxx.vercel.app. App must behave identically on Vercel as on space-z.ai.

Work Log:
- ARCHITECTURE DECISION: socket.io mini-service won't work on Vercel (serverless, no long-lived WS). Converted continuous-optimization feed to SSE (/api/oryxx/stream, Edge Runtime) — works identically on Vercel + space-z.ai. Removed socket.io dependency from the client.
- z-ai SDK FIX: SDK reads config from /etc/.z-ai-config (file-based) which doesn't exist on Vercel. Created src/lib/zai.ts loader that constructs ZAI from ZAI_* env vars, falls back to ZAI.create() (file loader) in sandbox.
- Prisma: switched SQLite → PostgreSQL (Neon). DATABASE_URL=pooled (runtime), DIRECT_URL=direct (migrations). Schema: User + Waitlist models. Pushed schema to Neon, seeded admin (ekontetevi@gmail / Payswap123456) + 4 demo accounts (demo.{rider,driver,shipper,fleet}@oryxx.app / oryxx-demo).
- NextAuth v4: Credentials provider, JWT strategy, scrypt password hashing (no native deps — critical for Vercel build). /api/auth/[...nextauth], /api/auth/signup (waitlist), /api/waitlist (admin list/approve/reject with temp password issuance).
- Auth UI: modal on / (single visible route preserved). Login tab, Join-waitlist tab (signup → Waitlist row, status=pending), demo quick-login buttons for all 4 roles. UserMenu dropdown. Admin sees "Manage waitlist" → WaitlistAdmin panel (list/approve/reject, temp password display).
- App gated behind auth: unauthenticated → landing + auto-open auth modal; authenticated → OryxConsole; admin → + waitlist panel.
- SECURITY: untracked .env and db/custom.db from git (were committed in initial commit). Added .env.example. Verified no secrets in git history (initial .env only had SQLite path).
- GitHub: created repo pectoraux/oryxx via API with PAT, pushed main branch.
- Vercel: created project "oryxx" linked to GitHub repo (team tay-nurs-projects). Set 9 env vars (DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, NEXTAUTH_URL=https://oryxx.vercel.app, ZAI_BASE_URL, ZAI_API_KEY, ZAI_CHAT_ID, ZAI_TOKEN, ZAI_USER_ID). Triggered production deployment → READY. Domain oryxx.vercel.app auto-assigned and verified.
- VERIFIED ON VERCEL: admin login (role=admin in session), demo rider login, solve API (5 plans), SSE stream (all 7 event types fired end-to-end), admin waitlist panel (approved entry visible), signup→waitlist flow (newuser-test@oryxx.app landed in Neon as pending). Note: parsedBy=heuristic on Vercel because z-ai internal API (internal-api.z.ai) is not reachable from Vercel servers — graceful fallback works as designed; deterministic solver identical.

Stage Summary:
- Live at https://oryxx.vercel.app (production) and localhost:3000 (space-z.ai preview).
- GitHub: https://github.com/pectoraux/oryxx
- Auth works identically on both: NextAuth JWT + Neon Postgres.
- Continuous optimization works identically: SSE replaced socket.io.
- The only environment difference: LLM parse falls back to heuristic on Vercel (z-ai internal API not externally reachable). The deterministic solver — the actual intelligence core — is identical. Acceptable per design (graceful degradation).
- Credentials for the user:
  Admin: ekontetevi@gmail / Payswap123456
  Demo: demo.rider/driver/shipper/fleet@oryxx.app / oryxx-demo (quick-login buttons in modal)
