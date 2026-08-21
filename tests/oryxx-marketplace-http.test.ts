// ORYXX — REAL HTTP-level marketplace integration tests (DB-backed).
//
// This test invokes the ACTUAL Next.js route handler (POST from
// src/app/api/oryxx/marketplace/route.ts) against a real PostgreSQL database
// (via Prisma). It exercises the complete marketplace transaction path:
//
//   create_demand → discover_supply → discover_opportunities → clear_market
//     → negotiate → accept_offer → authorize_payment → capture_payment
//     → reserve_execution → dispatch → complete_execution
//
// and verifies:
//   - Authorization: every mutation is bound to the authenticated user (email
//     derived from the JWT session via mocked getServerSession). Cross-account
//     access is rejected with 403.
//   - Idempotency: replaying authorize_payment with the same idempotency
//     context returns the existing PaymentIntent without modifying balances or
//     creating duplicate ledger entries.
//   - Concurrency safety: ledger entries are double-entry and atomic.
//   - Evidence boundary: SANDBOX execution never produces W3-M/W4-M evidence
//     (evidenceEligible=false by construction).
//   - Provenance: every created object has isMarketplaceOpportunity=true and
//     researchStimulus=false.
//
// PREREQUISITES:
//   - DATABASE_URL / DIRECT_URL must point to a real PostgreSQL database.
//   - The marketplace models (TransportationDemand, TransportationSupply,
//     TransportationOpportunity, MarketplaceOffer, MarketplaceAgreement,
//     TransportationExecution, MoneyAccount, LedgerEntry, PaymentIntent,
//     Settlement, MarketplaceEvent) must exist.
//
// CI: This test runs against a fresh PostgreSQL 16 service container per run.
// The workflow applies the Prisma schema via `prisma db push` before running.
//
// Local:
//   DATABASE_URL="postgresql://..." DIRECT_URL="postgresql://..." \
//     bun test tests/oryxx-marketplace-http.test.ts --timeout 600000
//
// NEVER run against production Neon — the test creates and deletes data.

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";
import { AsyncLocalStorage } from "async_hooks";
import { PrismaClient } from "@prisma/client";
import {
  canProduceMarketplaceEvidence,
  type TransportationExecution as DomainExecution,
  type ExecutionState,
  type Environment,
  type Provenance,
} from "../src/lib/oryxx/live/types";

// ─── Environment fix-up ────────────────────────────────────────────────
// The sandbox shell may export DATABASE_URL=file:... (SQLite) which shadows
// the PostgreSQL URL in .env. In production (Vercel), DATABASE_URL is the
// Neon pooled PostgreSQL URL. We restore the production contract here so the
// route's @/lib/db PrismaClient connects to the real PostgreSQL.
if (process.env.DIRECT_URL && !process.env.DATABASE_URL?.startsWith("postgres")) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

// ─── Auth boundary mock ────────────────────────────────────────────────
//
// The production route calls getServerSession(authOptions). We replace
// next-auth's getServerSession with a function that reads the session from
// an AsyncLocalStorage context. Each request carries its own authenticated
// identity without a shared mutable variable — mirroring how a real Next.js
// server resolves per-request sessions.
//
// The route derives email and role from session.user — the test NEVER
// supplies identity via the request body.
const sessionALS = new AsyncLocalStorage<{
  user: { email: string; role: string; id: string };
}>();

mock.module("next-auth", () => ({
  getServerSession: async () => sessionALS.getStore() ?? null,
  default: { getServerSession: async () => sessionALS.getStore() ?? null },
}));

// Import the ACTUAL production route handler AFTER the mock is registered.
const routeModule = await import("../src/app/api/oryxx/marketplace/route");
const POST = routeModule.POST;

// ─── Database client (the same PostgreSQL the production route uses) ─────
const db = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  },
});

// ─── Test scaffolding ───────────────────────────────────────────────────
// Unique tag so every test run's data is identifiable and cleanable.
const TEST_TAG = `mkt-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_START = new Date();
const emailFor = (label: string) => `${TEST_TAG}-${label}@oryxx.test`;

// Marker experiment (preregistered + activated) — created in beforeAll so
// the test run has an identifiable record in the experiments table. The
// marketplace route never uses this experiment directly (sandbox account
// funding is automatic via ensureSandboxAccount), but it serves as a
// per-run marker for traceability and mirrors the enrollment-test harness
// pattern.
let markerExperimentId: string;

// Shared state for the sequential lifecycle chain (tests 5–12).
let chainDemandId: string;
let chainOpportunityId: string;
let chainOfferId: string;
let chainAgreementId: string;
let chainPaymentIntentId: string;
let chainExecutionId: string;

// ─── Helpers ───────────────────────────────────────────────────────────

/** Run a callback as an authenticated user (session scoped via ALS). */
async function asUser<T>(
  email: string,
  role: string,
  fn: () => Promise<T>,
): Promise<T> {
  return sessionALS.run(
    { user: { email, role, id: `id-${email}` } },
    fn,
  );
}

/** Invoke the production POST handler with a JSON body as an authenticated user. */
async function callRoute(
  body: any,
  email: string,
  role: string = "user",
): Promise<{ status: number; body: any }> {
  return asUser(email, role, async () => {
    const req = new Request("http://localhost/api/oryxx/marketplace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    let parsed: any;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  });
}

/** Invoke the production POST handler WITHOUT a session (anonymous). */
async function callRouteUnauthenticated(body: any): Promise<{
  status: number;
  body: any;
}> {
  const req = new Request("http://localhost/api/oryxx/marketplace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

// ── Lifecycle helpers ──────────────────────────────────────────────────

async function createDemand(email: string, overrides: Record<string, any> = {}) {
  return callRoute({ mode: "create_demand", ...overrides }, email);
}

async function discoverSupply(email: string, demandId: string) {
  return callRoute({ mode: "discover_supply", demandId }, email);
}

async function discoverOpportunities(email: string, demandId: string) {
  return callRoute({ mode: "discover_opportunities", demandId }, email);
}

async function clearMarket(email: string, demandId: string) {
  return callRoute({ mode: "clear_market", demandId }, email);
}

async function negotiate(email: string, opportunityId: string) {
  return callRoute({ mode: "negotiate", opportunityId }, email);
}

async function acceptOffer(email: string, offerId: string) {
  return callRoute({ mode: "accept_offer", offerId }, email);
}

async function authorizePayment(email: string, agreementId: string) {
  return callRoute({ mode: "authorize_payment", agreementId }, email);
}

async function capturePayment(email: string, paymentIntentId: string) {
  return callRoute({ mode: "capture_payment", paymentIntentId }, email);
}

async function reserveExecution(email: string, agreementId: string) {
  return callRoute({ mode: "reserve_execution", agreementId }, email);
}

async function dispatch(email: string, executionId: string) {
  return callRoute({ mode: "dispatch", executionId }, email);
}

async function completeExecution(email: string, executionId: string) {
  return callRoute({ mode: "complete_execution", executionId }, email);
}

/** Walk through the full chain as `email` up to an accepted offer. */
async function setupChainToOffer(email: string) {
  const d = await createDemand(email);
  if (d.status !== 200) throw new Error(`create_demand failed: ${JSON.stringify(d.body)}`);
  const demandId: string = d.body.demand.id;
  await discoverSupply(email, demandId);
  const opps = await discoverOpportunities(email, demandId);
  if (opps.status !== 200 || !opps.body.opportunities?.length) {
    throw new Error(`discover_opportunities failed: ${JSON.stringify(opps.body)}`);
  }
  const opportunityId: string = opps.body.opportunities[0].id;
  const clr = await clearMarket(email, demandId);
  if (clr.status !== 200) throw new Error(`clear_market failed: ${JSON.stringify(clr.body)}`);
  const offerId: string = clr.body.offer.id;
  return { demandId, opportunityId, offerId };
}

/** Walk through the full chain as `email` up to a signed agreement. */
async function setupChainToAgreement(email: string) {
  const { demandId, opportunityId, offerId } = await setupChainToOffer(email);
  await negotiate(email, opportunityId);
  const acc = await acceptOffer(email, offerId);
  if (acc.status !== 200) throw new Error(`accept_offer failed: ${JSON.stringify(acc.body)}`);
  const agreementId: string = acc.body.agreement.id;
  return { demandId, opportunityId, offerId, agreementId };
}

/** Walk through the full chain as `email` up to a dispatched execution. */
async function setupChainToDispatchedExecution(email: string) {
  const base = await setupChainToAgreement(email);
  const auth = await authorizePayment(email, base.agreementId);
  if (auth.status !== 200) {
    throw new Error(`authorize_payment failed: ${JSON.stringify(auth.body)}`);
  }
  const paymentIntentId: string = auth.body.paymentIntent.id;
  await capturePayment(email, paymentIntentId);
  const res = await reserveExecution(email, base.agreementId);
  if (res.status !== 200) {
    throw new Error(`reserve_execution failed: ${JSON.stringify(res.body)}`);
  }
  const executionId: string = res.body.execution.id;
  const disp = await dispatch(email, executionId);
  if (disp.status !== 200) {
    throw new Error(`dispatch failed: ${JSON.stringify(disp.body)}`);
  }
  return { ...base, paymentIntentId, executionId };
}

/** Build a domain TransportationExecution from a DB row (for evidence checks). */
function dbExecutionToDomain(exec: {
  id: string;
  agreementId: string;
  opportunityId: string;
  demandId: string;
  supplyId: string;
  providerId: string;
  state: string;
  environment: string;
  evidenceEligible: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
}): DomainExecution {
  return {
    id: exec.id,
    agreementId: exec.agreementId,
    opportunityId: exec.opportunityId,
    demandId: exec.demandId,
    supplyId: exec.supplyId,
    providerId: exec.providerId,
    state: exec.state as ExecutionState,
    environment: exec.environment as Environment,
    evidenceEligible: exec.evidenceEligible,
    startedAt: exec.startedAt?.toISOString(),
    completedAt: exec.completedAt?.toISOString(),
    failureReason: exec.failureReason ?? undefined,
    provenance: {
      environment: exec.environment as Environment,
      source: "oryxx-owned" as Provenance["source"],
      observedAt: exec.createdAt.toISOString(),
      confidence: 1,
    },
    isMarketplaceOpportunity: true,
    researchStimulus: false,
    createdAt: exec.createdAt.toISOString(),
  };
}

// ─── Cleanup ────────────────────────────────────────────────────────────

/**
 * Delete all test data created during this run. Walks every relation in
 * reverse-dependency order so foreign keys never block a delete.
 *
 * Strategy:
 *   1. Find all test demands (userId contains TEST_TAG).
 *   2. Walk: opportunities → offers → agreements → executions → paymentIntents → settlements.
 *   3. Delete in reverse-topological order.
 *   4. Delete SANDBOX supplies created during this test run.
 *   5. Delete test customer accounts + their ledger entries.
 *   6. Delete the marker experiment.
 */
async function cleanupTestData() {
  // 1. Find all test demands
  const demands = await db.transportationDemand.findMany({
    where: { userId: { contains: TEST_TAG } },
    select: { id: true },
  });
  const demandIds = demands.map((d) => d.id);

  if (demandIds.length > 0) {
    // 2a. Opportunities for those demands
    const opportunities = await db.transportationOpportunity.findMany({
      where: { demandId: { in: demandIds } },
      select: { id: true },
    });
    const opportunityIds = opportunities.map((o) => o.id);

    // 2b. Offers for those demands
    const offers = await db.marketplaceOffer.findMany({
      where: { demandId: { in: demandIds } },
      select: { id: true },
    });
    const offerIds = offers.map((o) => o.id);

    // 2c. Agreements via opportunity IDs
    const agreements =
      opportunityIds.length > 0
        ? await db.marketplaceAgreement.findMany({
            where: { opportunityId: { in: opportunityIds } },
            select: { id: true },
          })
        : [];
    const agreementIds = agreements.map((a) => a.id);

    // 2d. Executions via agreement IDs
    const executions =
      agreementIds.length > 0
        ? await db.transportationExecution.findMany({
            where: { agreementId: { in: agreementIds } },
            select: { id: true },
          })
        : [];
    const executionIds = executions.map((e) => e.id);

    // 2e. PaymentIntents via demand IDs
    const paymentIntents = await db.paymentIntent.findMany({
      where: { demandId: { in: demandIds } },
      select: { id: true },
    });
    const paymentIntentIds = paymentIntents.map((p) => p.id);

    // 2f. Settlements via execution IDs
    const settlements =
      executionIds.length > 0
        ? await db.settlement.findMany({
            where: { executionId: { in: executionIds } },
            select: { id: true },
          })
        : [];
    const settlementIds = settlements.map((s) => s.id);

    // 2g. MarketplaceEvents (no FK — referenceId is a plain string)
    const allRefIds = [
      ...demandIds,
      ...opportunityIds,
      ...offerIds,
      ...agreementIds,
      ...executionIds,
      ...paymentIntentIds,
      ...settlementIds,
    ];
    if (allRefIds.length > 0) {
      await db.marketplaceEvent.deleteMany({
        where: { referenceId: { in: allRefIds } },
      });
    }

    // 2h. Ledger entries by referenceId. This deletes BOTH the DEBIT side
    //     (on test customer accounts) and the CREDIT side (on shared
    //     escrow / supplier / platform-revenue accounts) for our test
    //     paymentIntent / settlement / execution references. Without this,
    //     the CREDIT entries on shared accounts would accumulate across runs.
    const ledgerRefIds = [...paymentIntentIds, ...settlementIds, ...executionIds];
    if (ledgerRefIds.length > 0) {
      await db.ledgerEntry.deleteMany({
        where: { referenceId: { in: ledgerRefIds } },
      });
    }

    // 3. Delete in reverse-dependency order (FK-safe).
    if (executionIds.length > 0) {
      // Settlements (FK to execution) must go first.
      await db.settlement.deleteMany({
        where: { executionId: { in: executionIds } },
      });
      await db.transportationExecution.deleteMany({
        where: { id: { in: executionIds } },
      });
    }
    if (paymentIntentIds.length > 0) {
      await db.paymentIntent.deleteMany({
        where: { id: { in: paymentIntentIds } },
      });
    }
    if (agreementIds.length > 0) {
      await db.marketplaceAgreement.deleteMany({
        where: { id: { in: agreementIds } },
      });
    }
    if (offerIds.length > 0) {
      await db.marketplaceOffer.deleteMany({
        where: { id: { in: offerIds } },
      });
    }
    if (opportunityIds.length > 0) {
      await db.transportationOpportunity.deleteMany({
        where: { id: { in: opportunityIds } },
      });
    }
    await db.transportationDemand.deleteMany({
      where: { id: { in: demandIds } },
    });
  }

  // 4. Delete SANDBOX supplies created during this test run (no userId to
  //    filter by — use the test start timestamp).
  await db.transportationSupply.deleteMany({
    where: {
      environment: "SANDBOX",
      createdAt: { gte: TEST_START },
    },
  });

  // 5. Delete test customer accounts + any remaining ledger entries.
  //    Platform accounts (ownerId="oryxx-platform") are SHARED across runs
  //    and NOT deleted — their ledger entries were already removed by the
  //    referenceId-based delete above.
  const testAccounts = await db.moneyAccount.findMany({
    where: { ownerId: { contains: TEST_TAG } },
    select: { id: true },
  });
  if (testAccounts.length > 0) {
    const accountIds = testAccounts.map((a) => a.id);
    await db.ledgerEntry.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await db.moneyAccount.deleteMany({
      where: { id: { in: accountIds } },
    });
  }

  // 6. Delete the marker experiment (if created).
  if (markerExperimentId) {
    await db.experimentEnrollment.deleteMany({
      where: { experimentId: markerExperimentId },
    });
    await db.experimentEvent.deleteMany({
      where: { experimentId: markerExperimentId },
    });
    await db.acceptanceExperiment
      .delete({ where: { id: markerExperimentId } })
      .catch(() => {});
  }
}

/** Pre-cleanup: remove leftover experiments + marketplace data from previous runs. */
async function cleanupLeftover() {
  // Leftover marker experiments from killed runs.
  const leftoverExps = await db.acceptanceExperiment.findMany({
    where: { name: { contains: "Marketplace HTTP Test" } },
    select: { id: true },
  });
  for (const exp of leftoverExps) {
    await db.experimentEnrollment.deleteMany({
      where: { experimentId: exp.id },
    });
    await db.experimentEvent.deleteMany({
      where: { experimentId: exp.id },
    });
    await db.acceptanceExperiment
      .delete({ where: { id: exp.id } })
      .catch(() => {});
  }

  // Leftover sandbox supplies (any prior runs) — clears the slate so the
  // discover_supply / clear_market paths don't see stale data.
  await db.transportationSupply.deleteMany({
    where: { environment: "SANDBOX" },
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────────────

beforeAll(async () => {
  await cleanupLeftover();
  await cleanupTestData(); // safety: in case a prior run was killed

  // Create the marker experiment (preregistered + activated). This is the
  // per-run traceability record. The marketplace route never reads it
  // (sandbox account funding is implicit via ensureSandboxAccount) but it
  // serves as an audit marker and aligns with the enrollment-test harness.
  const exp = await db.acceptanceExperiment.create({
    data: {
      name: `Marketplace HTTP Test ${TEST_TAG}`,
      description:
        "Marker experiment for the marketplace HTTP test run. Cleaned up after the run.",
      status: "ACTIVE",
      maxDetourKm: 5.0,
      maxExtraTimeMin: 20.0,
      minCompensation: 1.0,
      hypothesis: "test-marker",
      sampleTarget: 1,
      primaryOutcome: "marketplace_e2e",
      stoppingRule: "test",
      randomizationSeed: 42,
      consentText: "test",
      consentVersion: 1,
      preregistrationHash: `marketplace-http-marker-${TEST_TAG}`,
      preregisteredAt: new Date().toISOString(),
      requiresConsent: false,
    },
  });
  markerExperimentId = exp.id;
}, 180000);

afterAll(async () => {
  await cleanupTestData();
  await db.$disconnect();
}, 180000);

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("ORYXX HTTP-level marketplace — production route", () => {
  // ─── A. AUTHORIZATION — OWNERSHIP GATE ──────────────────────────────
  describe("Authorization (ownership gate)", () => {
    // ─── 1. CREATE_DEMAND OWNERSHIP ───────────────────────────────────
    test("1. create_demand creates demand with correct ownership", async () => {
      const email = emailFor("own-create");
      const res = await createDemand(email);

      expect(res.status).toBe(200);
      expect(res.body.demand).toBeTruthy();
      expect(res.body.demand.id).toBeTruthy();
      // userId MUST equal the authenticated email (never trust the body)
      expect(res.body.demand.userId).toBe(email);
      expect(res.body.demand.environment).toBe("SANDBOX");
      expect(res.body.demand.status).toBe("OPEN");

      // DB state matches the response — single row, ownership bound.
      const dbRows = await db.transportationDemand.findMany({
        where: { userId: email },
      });
      expect(dbRows.length).toBe(1);
      expect(dbRows[0].id).toBe(res.body.demand.id);
      expect(dbRows[0].userId).toBe(email);
      expect(dbRows[0].environment).toBe("SANDBOX");

      // body-supplied userId is IGNORED — identity comes from the session.
      const spoofRes = await callRoute(
        {
          mode: "create_demand",
          userId: "attacker@evil.test",
        },
        email,
      );
      expect(spoofRes.status).toBe(200);
      expect(spoofRes.body.demand.userId).toBe(email);
      expect(spoofRes.body.demand.userId).not.toBe("attacker@evil.test");
    }, 60000);

    // ─── 2. CROSS-ACCOUNT CLEAR_MARKET ────────────────────────────────
    test("2. User B cannot clear user A's demand", async () => {
      const emailA = emailFor("clear-A");
      const emailB = emailFor("clear-B");

      // A creates a demand + discovers supply + discovers opportunities.
      const setup = await setupChainToOffer(emailA);
      // The setup already cleared the market as A — so re-clear should be a
      // no-op. To exercise the ownership gate properly, create a SECOND
      // demand as A and walk through discover_supply + discover_opportunities
      // (but NOT clear_market). Then attempt clear_market as B.
      const d2 = await createDemand(emailA);
      const demandIdA: string = d2.body.demand.id;
      await discoverSupply(emailA, demandIdA);
      const opps = await discoverOpportunities(emailA, demandIdA);
      expect(opps.body.opportunities.length).toBeGreaterThan(0);

      // B attempts to clear A's demand → 403.
      const bRes = await clearMarket(emailB, demandIdA);
      expect(bRes.status).toBe(403);
      expect(bRes.body?.error).toMatch(/forbidden|owned/i);

      // A can clear their own demand → 200.
      const aRes = await clearMarket(emailA, demandIdA);
      expect(aRes.status).toBe(200);

      // Reference the setup variables so they're not flagged unused.
      expect(setup.demandId).toBeTruthy();
    }, 120000);

    // ─── 3. CROSS-ACCOUNT AUTHORIZE_PAYMENT ──────────────────────────
    test("3. User B cannot authorize payment on A's agreement", async () => {
      const emailA = emailFor("auth-pay-A");
      const emailB = emailFor("auth-pay-B");

      // A walks the full chain up to a signed agreement.
      const setup = await setupChainToAgreement(emailA);
      const agreementIdA = setup.agreementId;

      // B attempts to authorize payment on A's agreement → 403.
      const bRes = await authorizePayment(emailB, agreementIdA);
      expect(bRes.status).toBe(403);
      expect(bRes.body?.error).toMatch(/forbidden|owned/i);

      // A can authorize payment on their own agreement → 200.
      const aRes = await authorizePayment(emailA, agreementIdA);
      expect(aRes.status).toBe(200);
      expect(aRes.body.paymentIntent.status).toBe("AUTHORIZED");
    }, 120000);

    // ─── 4. CROSS-ACCOUNT COMPLETE_EXECUTION ──────────────────────────
    test("4. User B cannot complete A's execution", async () => {
      const emailA = emailFor("comp-A");
      const emailB = emailFor("comp-B");

      // A walks the full chain up to a dispatched execution.
      const setup = await setupChainToDispatchedExecution(emailA);
      const executionIdA = setup.executionId;

      // B attempts to complete A's execution → 403.
      const bRes = await completeExecution(emailB, executionIdA);
      expect(bRes.status).toBe(403);
      expect(bRes.body?.error).toMatch(/forbidden|owned/i);

      // A can complete their own execution → 200 (verified below in the
      // lifecycle chain). Here we just confirm ownership is enforced.
      const aRes = await completeExecution(emailA, executionIdA);
      expect(aRes.status).toBe(200);
      expect(aRes.body.execution.state).toBe("COMPLETED");
    }, 180000);
  });

  // ─── B. END-TO-END MARKETPLACE LIFECYCLE ─────────────────────────────
  describe("End-to-end marketplace lifecycle", () => {
    // ─── 5. CLEAR_MARKET CALLS CLEAR_MARKET ENGINE ────────────────────
    test("5. clear_market calls clearMarket engine", async () => {
      const email = emailFor("lifecycle");

      // Create demand + discover supply + discover opportunities.
      const d = await createDemand(email);
      expect(d.status).toBe(200);
      chainDemandId = d.body.demand.id;

      const sup = await discoverSupply(email, chainDemandId);
      expect(sup.status).toBe(200);
      expect(sup.body.count).toBeGreaterThan(0);

      const opps = await discoverOpportunities(email, chainDemandId);
      expect(opps.status).toBe(200);
      expect(opps.body.opportunities.length).toBeGreaterThan(0);
      chainOpportunityId = opps.body.opportunities[0].id;

      // Clear the market → expect solver audit metadata + PENDING offer.
      const clr = await clearMarket(email, chainDemandId);
      expect(clr.status).toBe(200);
      expect(clr.body.offer).toBeTruthy();
      expect(clr.body.offer.status).toBe("PENDING");
      expect(clr.body.offer.opportunityId).toBe(chainOpportunityId);
      expect(clr.body.offer.isMarketplaceOpportunity).toBe(true);
      expect(clr.body.offer.researchStimulus).toBe(false);

      // Solver audit metadata is present (proves the real ClearingEngine ran).
      expect(clr.body.solverVersion).toMatch(/oryxx-clearing-v/);
      expect(clr.body.solverMode).toBe("greedy-welfare-maximizing");
      expect(clr.body.optimizationTimestamp).toBeTruthy();
      // optimizationTimestamp is a valid ISO date.
      expect(new Date(clr.body.optimizationTimestamp).getTime()).not.toBeNaN();

      // DB: offer row exists with status=PENDING.
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: clr.body.offer.id },
      });
      expect(dbOffer).toBeTruthy();
      expect(dbOffer!.status).toBe("PENDING");
      expect(dbOffer!.isMarketplaceOpportunity).toBe(true);
      expect(dbOffer!.researchStimulus).toBe(false);

      // DB: opportunity transitioned DISCOVERED → OFFERED.
      const dbOpp = await db.transportationOpportunity.findUnique({
        where: { id: chainOpportunityId },
      });
      expect(dbOpp!.status).toBe("OFFERED");

      // DB: demand transitioned OPEN → MATCHED.
      const dbDemand = await db.transportationDemand.findUnique({
        where: { id: chainDemandId },
      });
      expect(dbDemand!.status).toBe("MATCHED");

      chainOfferId = clr.body.offer.id;
    }, 120000);

    // ─── 6. NEGOTIATE CREATES AND RESOLVES NEGOTIATION ────────────────
    test("6. negotiate creates and resolves negotiation", async () => {
      const email = emailFor("lifecycle");
      expect(chainOpportunityId).toBeTruthy();

      const neg = await negotiate(email, chainOpportunityId);
      expect(neg.status).toBe(200);
      expect(neg.body.negotiation).toBeTruthy();
      // Negotiation must be resolved (ACCEPTED, REJECTED, or SETTLED — not OPEN).
      expect(["ACCEPTED", "REJECTED", "SETTLED", "EXPIRED"]).toContain(
        neg.body.negotiation.state,
      );
      // If accepted, finalPrice must be a non-negative integer (minor units).
      if (neg.body.negotiation.state === "ACCEPTED") {
        expect(neg.body.negotiation.finalPrice).not.toBeNull();
        expect(typeof neg.body.negotiation.finalPrice).toBe("number");
        expect(neg.body.negotiation.finalPrice).toBeGreaterThanOrEqual(0);
      }
      // Reservation price + bounds are present (proves the NegotiationEngine ran).
      expect(neg.body.negotiation.minimumPrice).toBeDefined();
      expect(neg.body.negotiation.maximumPrice).toBeDefined();
      expect(neg.body.negotiation.reservationPrice).toBeDefined();
      expect(neg.body.negotiation.id).toBeTruthy();
      expect(neg.body.opportunity.id).toBe(chainOpportunityId);
    }, 60000);

    // ─── 7. ACCEPT_OFFER TRANSITIONS THROUGH CORRECT STATES ──────────
    test("7. accept_offer transitions through correct states", async () => {
      const email = emailFor("lifecycle");
      expect(chainOfferId).toBeTruthy();

      const acc = await acceptOffer(email, chainOfferId);
      expect(acc.status).toBe(200);
      expect(acc.body.offer).toBeTruthy();
      expect(acc.body.offer.status).toBe("ACCEPTED");
      expect(acc.body.agreement).toBeTruthy();

      chainAgreementId = acc.body.agreement.id;

      // DB: offer = ACCEPTED.
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: chainOfferId },
      });
      expect(dbOffer!.status).toBe("ACCEPTED");

      // DB: agreement created (ACTIVE).
      const dbAgg = await db.marketplaceAgreement.findUnique({
        where: { id: chainAgreementId },
      });
      expect(dbAgg).toBeTruthy();
      expect(dbAgg!.status).toBe("ACTIVE");
      expect(dbAgg!.isMarketplaceOpportunity).toBe(true);
      expect(dbAgg!.researchStimulus).toBe(false);

      // DB: supply transitioned AVAILABLE → RESERVED.
      const dbOpp = await db.transportationOpportunity.findUnique({
        where: { id: chainOpportunityId },
      });
      const dbSupply = await db.transportationSupply.findUnique({
        where: { id: dbOpp!.supplyId },
      });
      expect(dbSupply!.status).toBe("RESERVED");

      // DB: opportunity transitioned OFFERED → ACCEPTED.
      expect(dbOpp!.status).toBe("ACCEPTED");
    }, 60000);

    // ─── 8. AUTHORIZE_PAYMENT CREATES DB LEDGER ENTRIES ──────────────
    test("8. authorize_payment creates DB ledger entries", async () => {
      const email = emailFor("lifecycle");
      expect(chainAgreementId).toBeTruthy();

      const auth = await authorizePayment(email, chainAgreementId);
      expect(auth.status).toBe(200);
      expect(auth.body.paymentIntent).toBeTruthy();
      expect(auth.body.paymentIntent.status).toBe("AUTHORIZED");
      expect(auth.body.paymentIntent.amount).toBeGreaterThan(0);

      chainPaymentIntentId = auth.body.paymentIntent.id;

      // DB: PaymentIntent row exists with status=AUTHORIZED.
      const dbIntent = await db.paymentIntent.findUnique({
        where: { id: chainPaymentIntentId },
      });
      expect(dbIntent).toBeTruthy();
      expect(dbIntent!.status).toBe("AUTHORIZED");
      expect(dbIntent!.environment).toBe("SANDBOX");

      // DB: LedgerEntry rows exist — DEBIT customer, CREDIT escrow.
      const entries = await db.ledgerEntry.findMany({
        where: { referenceType: "payment-intent", referenceId: chainPaymentIntentId },
      });
      // At minimum: 1 DEBIT + 1 CREDIT from authorization.
      const debits = entries.filter((e) => e.type === "DEBIT");
      const credits = entries.filter((e) => e.type === "CREDIT");
      expect(debits.length).toBeGreaterThanOrEqual(1);
      expect(credits.length).toBeGreaterThanOrEqual(1);

      // Each entry has a unique idempotencyKey (double-entry integrity).
      const keys = new Set(entries.map((e) => e.idempotencyKey));
      expect(keys.size).toBe(entries.length);

      // Each debit has a paired credit (pairedEntryId is non-empty after
      // the postDoubleEntry back-fill).
      for (const d of debits) {
        expect(d.pairedEntryId).toBeTruthy();
      }

      // DB: customer account balance DECREASED (DEBIT).
      const customerAccount = await db.moneyAccount.findFirst({
        where: { ownerId: email, type: "customer", environment: "SANDBOX" },
      });
      expect(customerAccount).toBeTruthy();
      // Initial sandbox balance is 10000 cents; after a positive DEBIT it
      // must be strictly less than that.
      expect(customerAccount!.balance).toBeLessThan(10000);

      // DB: escrow account balance INCREASED (CREDIT) by the same amount.
      const escrowAccount = await db.moneyAccount.findFirst({
        where: { ownerId: "oryxx-platform", type: "escrow", environment: "SANDBOX" },
      });
      expect(escrowAccount).toBeTruthy();
      expect(escrowAccount!.balance).toBeGreaterThanOrEqual(dbIntent!.amount);
    }, 60000);

    // ─── 9. CAPTURE_PAYMENT POSTS SUPPLIER + PLATFORM ENTRIES ─────────
    test("9. capture_payment posts supplier + platform entries", async () => {
      const email = emailFor("lifecycle");
      expect(chainPaymentIntentId).toBeTruthy();

      // Snapshot balances before capture.
      const intent = await db.paymentIntent.findUnique({
        where: { id: chainPaymentIntentId },
      });
      expect(intent).toBeTruthy();

      const supplierAccountBefore = await db.moneyAccount.findFirst({
        where: { ownerId: intent!.supplierId, type: "supplier", environment: "SANDBOX" },
      });
      const platformAccountBefore = await db.moneyAccount.findFirst({
        where: { ownerId: "oryxx-platform", type: "platform-revenue", environment: "SANDBOX" },
      });

      const cap = await capturePayment(email, chainPaymentIntentId);
      expect(cap.status).toBe(200);
      expect(cap.body.paymentIntent).toBeTruthy();
      expect(cap.body.paymentIntent.status).toBe("CAPTURED");
      expect(cap.body.paymentIntent.captureId).toBeTruthy();

      // DB: PaymentIntent = CAPTURED.
      const dbIntent = await db.paymentIntent.findUnique({
        where: { id: chainPaymentIntentId },
      });
      expect(dbIntent!.status).toBe("CAPTURED");
      expect(dbIntent!.capturedAt).toBeTruthy();

      // DB: supplier account credited by supplierCompensation.
      const supplierAccountAfter = await db.moneyAccount.findFirst({
        where: { ownerId: intent!.supplierId, type: "supplier", environment: "SANDBOX" },
      });
      const supplierDelta =
        supplierAccountAfter!.balance - (supplierAccountBefore?.balance ?? 0);
      expect(supplierDelta).toBe(intent!.supplierCompensation);

      // DB: platform-revenue account credited by platformFee.
      const platformAccountAfter = await db.moneyAccount.findFirst({
        where: { ownerId: "oryxx-platform", type: "platform-revenue", environment: "SANDBOX" },
      });
      const platformDelta =
        platformAccountAfter!.balance - (platformAccountBefore?.balance ?? 0);
      expect(platformDelta).toBe(intent!.platformFee);

      // DB: 4 additional ledger entries (2 for supplier, 2 for platform).
      const entries = await db.ledgerEntry.findMany({
        where: { referenceType: "payment-intent", referenceId: chainPaymentIntentId },
      });
      // 2 from authorize + 2 from supplier capture + 2 from platform capture = 6
      expect(entries.length).toBe(6);
      const captureKeys = entries
        .map((e) => e.idempotencyKey)
        .filter((k) => k.includes("capture"));
      expect(captureKeys.length).toBe(4);
    }, 60000);

    // ─── 10. RESERVE_EXECUTION CREATES EXECUTION (evidenceEligible=false)
    test("10. reserve_execution creates execution with evidenceEligible=false", async () => {
      const email = emailFor("lifecycle");
      expect(chainAgreementId).toBeTruthy();

      const res = await reserveExecution(email, chainAgreementId);
      expect(res.status).toBe(200);
      expect(res.body.execution).toBeTruthy();
      expect(res.body.execution.state).toBe("RESERVED");
      // SANDBOX execution NEVER produces W3-M/W4-M.
      expect(res.body.execution.evidenceEligible).toBe(false);
      expect(res.body.execution.environment).toBe("SANDBOX");
      expect(res.body.execution.isMarketplaceOpportunity).toBe(true);
      expect(res.body.execution.researchStimulus).toBe(false);

      chainExecutionId = res.body.execution.id;

      // DB: execution row exists with state=RESERVED + evidenceEligible=false.
      const dbExec = await db.transportationExecution.findUnique({
        where: { id: chainExecutionId },
      });
      expect(dbExec).toBeTruthy();
      expect(dbExec!.state).toBe("RESERVED");
      expect(dbExec!.evidenceEligible).toBe(false);

      // DB: supply transitioned RESERVED → COMMITTED.
      const dbOpp = await db.transportationOpportunity.findUnique({
        where: { id: chainOpportunityId },
      });
      const dbSupply = await db.transportationSupply.findUnique({
        where: { id: dbOpp!.supplyId },
      });
      expect(dbSupply!.status).toBe("COMMITTED");

      // DB: demand transitioned MATCHED → IN_PROGRESS.
      const dbDemand = await db.transportationDemand.findUnique({
        where: { id: chainDemandId },
      });
      expect(dbDemand!.status).toBe("IN_PROGRESS");

      // Evidence boundary: sandbox execution cannot produce W3-M/W4-M.
      const domainExec = dbExecutionToDomain(dbExec!);
      const evidence = canProduceMarketplaceEvidence(domainExec);
      expect(evidence.w3m).toBe(false);
      expect(evidence.w4m).toBe(false);
      expect(evidence.reason).toMatch(/SANDBOX|sandbox|environment/i);
    }, 60000);

    // ─── 11. COMPLETE_EXECUTION TRANSITIONS TO COMPLETED ─────────────
    test("11. complete_execution transitions to COMPLETED", async () => {
      const email = emailFor("lifecycle");
      expect(chainExecutionId).toBeTruthy();

      // First, dispatch the execution (provider adapter starts it).
      const disp = await dispatch(email, chainExecutionId);
      expect(disp.status).toBe(200);
      expect(disp.body.execution.state).toMatch(/DISPATCHED|EN_ROUTE/);

      // Now complete the execution.
      const comp = await completeExecution(email, chainExecutionId);
      expect(comp.status).toBe(200);
      expect(comp.body.execution).toBeTruthy();
      expect(comp.body.execution.state).toBe("COMPLETED");

      // DB: execution.state = COMPLETED.
      const dbExec = await db.transportationExecution.findUnique({
        where: { id: chainExecutionId },
      });
      expect(dbExec!.state).toBe("COMPLETED");
      expect(dbExec!.completedAt).toBeTruthy();
      // SANDBOX execution never produces W3-M/W4-M — even at COMPLETED.
      expect(dbExec!.evidenceEligible).toBe(false);

      // DB: demand transitioned IN_PROGRESS → COMPLETED.
      const dbDemand = await db.transportationDemand.findUnique({
        where: { id: chainDemandId },
      });
      expect(dbDemand!.status).toBe("COMPLETED");

      // DB: settlement created (SETTLED — funds already credited at capture).
      const settlements = await db.settlement.findMany({
        where: { executionId: chainExecutionId },
      });
      expect(settlements.length).toBe(1);
      expect(settlements[0].status).toBe("SETTLED");
      expect(settlements[0].supplierId).toBe(dbExec!.providerId);
      expect(settlements[0].amount).toBeGreaterThan(0);

      // Response explicitly states no marketplace evidence produced.
      expect(comp.body.evidenceProduced).toBeTruthy();
      expect(comp.body.evidenceProduced.w3m).toBe(false);
      expect(comp.body.evidenceProduced.w4m).toBe(false);
    }, 90000);

    // ─── 12. SANDBOX EXECUTION CANNOT PRODUCE W3-M / W4-M ────────────
    test("12. Sandbox execution cannot produce W3-M/W4-M", async () => {
      const email = emailFor("lifecycle");
      expect(chainExecutionId).toBeTruthy();

      // Verify evidenceEligible=false throughout the persisted execution
      // history (the execution is now COMPLETED but still evidenceEligible=false).
      const dbExec = await db.transportationExecution.findUnique({
        where: { id: chainExecutionId },
      });
      expect(dbExec).toBeTruthy();
      expect(dbExec!.evidenceEligible).toBe(false);
      expect(dbExec!.environment).toBe("SANDBOX");

      // canProduceMarketplaceEvidence(execution) returns w3m=false, w4m=false
      // for SANDBOX regardless of execution state.
      const domainExec = dbExecutionToDomain(dbExec!);
      const evidence = canProduceMarketplaceEvidence(domainExec);
      expect(evidence.w3m).toBe(false);
      expect(evidence.w4m).toBe(false);
      // Reason explicitly identifies the SANDBOX exclusion.
      expect(evidence.reason).toMatch(/SANDBOX|sandbox|environment/i);

      // Cross-check against a synthetic LIVE+COMPLETED execution to confirm
      // the function would return w3m=true, w4m=true for LIVE state. This
      // proves the false result for SANDBOX is environment-driven, not a
      // bug in the evidence function.
      const liveLike: DomainExecution = {
        ...domainExec,
        environment: "LIVE",
        evidenceEligible: true,
      };
      const liveEvidence = canProduceMarketplaceEvidence(liveLike);
      expect(liveEvidence.w3m).toBe(true);
      expect(liveEvidence.w4m).toBe(true);
    }, 60000);
  });

  // ─── C. IDEMPOTENCY + PROVENANCE ─────────────────────────────────────
  describe("Idempotency + provenance", () => {
    // ─── 13. DOUBLE AUTHORIZATION IS IDEMPOTENT ───────────────────────
    test("13. Double authorization is idempotent", async () => {
      const email = emailFor("idempotent");

      // Build a fresh chain up to a signed agreement.
      const setup = await setupChainToAgreement(email);
      const agreementId = setup.agreementId;

      // First authorization → 200, AUTHORIZED.
      const first = await authorizePayment(email, agreementId);
      expect(first.status).toBe(200);
      expect(first.body.paymentIntent.status).toBe("AUTHORIZED");
      const intentId = first.body.paymentIntent.id;

      // Snapshot ledger entries after the first authorization.
      const entriesAfterFirst = await db.ledgerEntry.findMany({
        where: { referenceType: "payment-intent", referenceId: intentId },
      });
      // Exactly 2 entries (1 DEBIT customer, 1 CREDIT escrow) — double-entry.
      expect(entriesAfterFirst.length).toBe(2);
      const debitsAfterFirst = entriesAfterFirst.filter((e) => e.type === "DEBIT");
      const creditsAfterFirst = entriesAfterFirst.filter((e) => e.type === "CREDIT");
      expect(debitsAfterFirst.length).toBe(1);
      expect(creditsAfterFirst.length).toBe(1);

      // Snapshot customer balance after first authorization.
      const customerAfterFirst = await db.moneyAccount.findFirst({
        where: { ownerId: email, type: "customer", environment: "SANDBOX" },
      });
      const balanceAfterFirst = customerAfterFirst!.balance;

      // Second authorization with the SAME idempotency context (same agreement).
      const second = await authorizePayment(email, agreementId);
      expect(second.status).toBe(200);
      // Same PaymentIntent returned — no duplicate created.
      expect(second.body.paymentIntent.id).toBe(intentId);
      expect(second.body.message).toMatch(/idempotent/i);

      // DB: ledger entry count UNCHANGED — no double charge.
      const entriesAfterSecond = await db.ledgerEntry.findMany({
        where: { referenceType: "payment-intent", referenceId: intentId },
      });
      expect(entriesAfterSecond.length).toBe(2);

      // DB: customer balance UNCHANGED — no second debit.
      const customerAfterSecond = await db.moneyAccount.findFirst({
        where: { ownerId: email, type: "customer", environment: "SANDBOX" },
      });
      expect(customerAfterSecond!.balance).toBe(balanceAfterFirst);

      // DB: PaymentIntent row count for this agreement is exactly 1.
      const intents = await db.paymentIntent.findMany({
        where: { agreementId },
      });
      expect(intents.length).toBe(1);
    }, 120000);

    // ─── 14. MARKETPLACE OBJECTS ARE TAGGED CORRECTLY ────────────────
    test("14. Marketplace objects are tagged correctly", async () => {
      // Query every marketplace object type created during this run and
      // verify isMarketplaceOpportunity=true and researchStimulus=false.
      // These are the provenance invariants that prevent marketplace
      // objects from contaminating the research instrument (W3-R/W4-R).

      // Find all test demands (filter by userId containing TEST_TAG).
      const demands = await db.transportationDemand.findMany({
        where: { userId: { contains: TEST_TAG } },
        select: { id: true },
      });
      const demandIds = demands.map((d) => d.id);
      expect(demandIds.length).toBeGreaterThan(0);

      // Opportunities
      const opportunities = await db.transportationOpportunity.findMany({
        where: { demandId: { in: demandIds } },
      });
      expect(opportunities.length).toBeGreaterThan(0);
      for (const opp of opportunities) {
        expect(opp.isMarketplaceOpportunity).toBe(true);
        expect(opp.researchStimulus).toBe(false);
        expect(opp.environment).toBe("SANDBOX");
      }

      // Offers
      const offers = await db.marketplaceOffer.findMany({
        where: { demandId: { in: demandIds } },
      });
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(offer.isMarketplaceOpportunity).toBe(true);
        expect(offer.researchStimulus).toBe(false);
        expect(offer.environment).toBe("SANDBOX");
      }

      // Agreements (via opportunity IDs)
      const opportunityIds = opportunities.map((o) => o.id);
      const agreements = await db.marketplaceAgreement.findMany({
        where: { opportunityId: { in: opportunityIds } },
      });
      expect(agreements.length).toBeGreaterThan(0);
      for (const agg of agreements) {
        expect(agg.isMarketplaceOpportunity).toBe(true);
        expect(agg.researchStimulus).toBe(false);
        expect(agg.environment).toBe("SANDBOX");
      }

      // Executions (via agreement IDs)
      const agreementIds = agreements.map((a) => a.id);
      const executions = await db.transportationExecution.findMany({
        where: { agreementId: { in: agreementIds } },
      });
      expect(executions.length).toBeGreaterThan(0);
      for (const exec of executions) {
        expect(exec.isMarketplaceOpportunity).toBe(true);
        expect(exec.researchStimulus).toBe(false);
        expect(exec.environment).toBe("SANDBOX");
        // SANDBOX execution NEVER produces W3-M/W4-M evidence.
        expect(exec.evidenceEligible).toBe(false);
      }

      // PaymentIntents (via demand IDs) — environment tag only (no
      // isMarketplaceOpportunity / researchStimulus columns on this table).
      const paymentIntents = await db.paymentIntent.findMany({
        where: { demandId: { in: demandIds } },
      });
      expect(paymentIntents.length).toBeGreaterThan(0);
      for (const pi of paymentIntents) {
        expect(pi.environment).toBe("SANDBOX");
      }

      // Settlements (via execution IDs) — environment tag only.
      const executionIds = executions.map((e) => e.id);
      if (executionIds.length > 0) {
        const settlements = await db.settlement.findMany({
          where: { executionId: { in: executionIds } },
        });
        for (const s of settlements) {
          expect(s.environment).toBe("SANDBOX");
        }
      }

      // Ledger entries — environment tag only. Verify they're all SANDBOX
      // for our test customer accounts.
      const testAccounts = await db.moneyAccount.findMany({
        where: { ownerId: { contains: TEST_TAG } },
        select: { id: true },
      });
      if (testAccounts.length > 0) {
        const accountIds = testAccounts.map((a) => a.id);
        const entries = await db.ledgerEntry.findMany({
          where: { accountId: { in: accountIds } },
        });
        for (const e of entries) {
          expect(e.environment).toBe("SANDBOX");
        }
      }
    }, 120000);
  });

  // ─── D. UNAUTHENTICATED REQUEST ───────────────────────────────────────
  describe("Authentication", () => {
    test("Unauthenticated request (no session) → HTTP 401", async () => {
      const res = await callRouteUnauthenticated({ mode: "create_demand" });
      expect(res.status).toBe(401);
      expect(res.body?.error).toMatch(/authentication/i);
    }, 30000);
  });
});
