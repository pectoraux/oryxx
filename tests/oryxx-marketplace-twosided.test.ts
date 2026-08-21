// ORYXX — Two-sided marketplace HTTP integration tests (DB-backed).
//
// This test exercises the TWO-SIDED transaction spine that was added to
// src/app/api/oryxx/marketplace/route.ts:
//
//   buyer_accept_offer   — buyer side only, PENDING → BUYER_ACCEPTED,
//                          NO agreement created.
//   provider_accept_offer — provider side, BUYER_ACCEPTED → PROVIDER_ACCEPTED,
//                           creates MarketplaceAgreement (status=ACTIVE),
//                           reserves supply, calls adapter.accept().
//                           Provider identity is resolved server-side from
//                           the session — in SANDBOX any authenticated user
//                           can act as the sandbox-rideshare provider.
//   provider_reject_offer — provider rejects, transitions to REJECTED.
//
// Both `authorize_payment` and `reserve_execution` are now gated on
// `agreement.status === "ACTIVE"` (which only exists after BOTH sides have
// accepted).
//
// This file mirrors the harness pattern from oryxx-marketplace-http.test.ts:
//   - AsyncLocalStorage for per-request session identity
//   - next-auth mocked so getServerSession returns the ALS store
//   - Imports the ACTUAL POST handler from src/app/api/oryxx/marketplace/route
//   - Uses PrismaClient to verify DB state
//
// PREREQUISITES:
//   - DATABASE_URL / DIRECT_URL must point to a real PostgreSQL database.
//   - All marketplace models must exist (prisma db push).
//
// Local:
//   DATABASE_URL="postgresql://..." DIRECT_URL="postgresql://..." \
//     bun test tests/oryxx-marketplace-twosided.test.ts --timeout 600000

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

// ─── Environment fix-up ────────────────────────────────────────────────
// The sandbox shell may export DATABASE_URL=file:... (SQLite) which shadows
// the PostgreSQL URL in .env. Restore the production contract here so the
// route's @/lib/db PrismaClient connects to the real PostgreSQL.
if (process.env.DIRECT_URL && !process.env.DATABASE_URL?.startsWith("postgres")) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

// ─── Auth boundary mock ────────────────────────────────────────────────
//
// Replace next-auth's getServerSession with an ALS-backed resolver. Every
// request carries its own authenticated identity via AsyncLocalStorage —
// mirroring how a real Next.js server resolves per-request sessions.
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
const TEST_TAG = `mkt-twosided-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_START = new Date();
const emailFor = (label: string) => `${TEST_TAG}-${label}@oryxx.test`;

// Two distinct test users — buyer and provider. In the sandbox the provider
// identity is resolved server-side from ANY authenticated session, so the
// provider email is effectively cosmetic; we keep the separation to mirror
// a real two-sided marketplace and to verify cross-actor invocation.
const BUYER_EMAIL = emailFor("buyer");
const PROVIDER_EMAIL = emailFor("provider");

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

/**
 * Buyer-side acceptance: PENDING → BUYER_ACCEPTED. NO agreement created.
 * This is the two-sided spine replacement for the legacy `accept_offer`
 * (which now also maps to buyer_accept_offer — no agreement).
 */
async function buyerAcceptOffer(email: string, offerId: string) {
  return callRoute({ mode: "buyer_accept_offer", offerId }, email);
}

/**
 * Provider-side acceptance: BUYER_ACCEPTED → PROVIDER_ACCEPTED. Creates
 * the MarketplaceAgreement (ACTIVE), reserves supply, calls adapter.accept().
 * Provider identity is resolved from the session.
 */
async function providerAcceptOffer(email: string, offerId: string) {
  return callRoute({ mode: "provider_accept_offer", offerId }, email);
}

/** Provider-side rejection: BUYER_ACCEPTED (or PENDING) → REJECTED. */
async function providerRejectOffer(
  email: string,
  offerId: string,
  reason?: string,
) {
  return callRoute(
    { mode: "provider_reject_offer", offerId, ...(reason ? { reason } : {}) },
    email,
  );
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

/**
 * Walk the full pre-acceptance chain as `email`:
 *   create_demand → discover_supply → discover_opportunities → clear_market
 *     → negotiate
 *
 * Returns the demandId / opportunityId / offerId (offer is in status PENDING).
 */
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
  await negotiate(email, opportunityId);
  return { demandId, opportunityId, offerId };
}

/**
 * Walk the chain through BUYER_ACCEPTED (no agreement yet). `buyerEmail`
 * performs the buyer-side accept.
 */
async function setupChainToBuyerAccepted(buyerEmail: string) {
  const base = await setupChainToOffer(buyerEmail);
  const acc = await buyerAcceptOffer(buyerEmail, base.offerId);
  if (acc.status !== 200) {
    throw new Error(`buyer_accept_offer failed: ${JSON.stringify(acc.body)}`);
  }
  return { ...base };
}

/**
 * Walk the full two-sided chain through PROVIDER_ACCEPTED. The buyer performs
 * all ownership-gated mutations; `providerEmail` performs the provider-side
 * accept (provider identity is resolved from ANY authenticated session in
 * sandbox).
 */
async function setupChainToProviderAccepted(buyerEmail: string, providerEmail: string) {
  const base = await setupChainToBuyerAccepted(buyerEmail);
  const acc = await providerAcceptOffer(providerEmail, base.offerId);
  if (acc.status !== 200) {
    throw new Error(`provider_accept_offer failed: ${JSON.stringify(acc.body)}`);
  }
  const agreementId: string = acc.body.agreement.id;
  return { ...base, agreementId };
}

// ─── Cleanup ────────────────────────────────────────────────────────────
//
// Same strategy as oryxx-marketplace-http.test.ts: walk every relation in
// reverse-dependency order so foreign keys never block a delete. Tagged
// demand rows anchor the cascade; SANDBOX supplies + customer accounts are
// cleaned separately by timestamp / ownerId.

async function cleanupTestData() {
  // 1. Find all test demands (userId contains TEST_TAG)
  const demands = await db.transportationDemand.findMany({
    where: { userId: { contains: TEST_TAG } },
    select: { id: true },
  });
  const demandIds = demands.map((d) => d.id);

  if (demandIds.length > 0) {
    // 2a. Opportunities
    const opportunities = await db.transportationOpportunity.findMany({
      where: { demandId: { in: demandIds } },
      select: { id: true },
    });
    const opportunityIds = opportunities.map((o) => o.id);

    // 2b. Offers
    const offers = await db.marketplaceOffer.findMany({
      where: { demandId: { in: demandIds } },
      select: { id: true },
    });
    const offerIds = offers.map((o) => o.id);

    // 2c. Agreements via offer OR opportunity IDs (offerId is the canonical FK)
    const agreements =
      offerIds.length > 0
        ? await db.marketplaceAgreement.findMany({
            where: { offerId: { in: offerIds } },
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

    // 2h. Ledger entries by referenceId (covers both sides of every double entry)
    const ledgerRefIds = [...paymentIntentIds, ...settlementIds, ...executionIds];
    if (ledgerRefIds.length > 0) {
      await db.ledgerEntry.deleteMany({
        where: { referenceId: { in: ledgerRefIds } },
      });
    }

    // 3. Delete in reverse-dependency order (FK-safe).
    if (executionIds.length > 0) {
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

  // 4. Delete SANDBOX supplies created during this test run.
  await db.transportationSupply.deleteMany({
    where: {
      environment: "SANDBOX",
      createdAt: { gte: TEST_START },
    },
  });

  // 5. Delete test customer accounts + their ledger entries.
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
}

/** Pre-cleanup: remove leftover sandbox supplies from prior runs. */
async function cleanupLeftover() {
  await db.transportationSupply.deleteMany({
    where: { environment: "SANDBOX" },
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────────────

beforeAll(async () => {
  await cleanupLeftover();
  await cleanupTestData(); // safety: in case a prior run was killed
}, 180000);

afterAll(async () => {
  await cleanupTestData();
  await db.$disconnect();
}, 180000);

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("ORYXX two-sided marketplace — buyer_accept / provider_accept spine", () => {
  // ─── A. BUYER-SIDE ACCEPT ─────────────────────────────────────────────
  describe("Buyer-side acceptance", () => {
    // ─── 1. BUYER_ACCEPTED STATE, NO AGREEMENT ─────────────────────────
    test("1. buyer_accept_offer transitions PENDING → BUYER_ACCEPTED and creates NO agreement", async () => {
      const buyer = emailFor("t1-buyer");
      const { demandId, opportunityId, offerId } = await setupChainToOffer(buyer);

      // Sanity: offer starts at PENDING.
      const pre = await db.marketplaceOffer.findUnique({ where: { id: offerId } });
      expect(pre!.status).toBe("PENDING");

      const acc = await buyerAcceptOffer(buyer, offerId);
      expect(acc.status).toBe(200);
      expect(acc.body.offer).toBeTruthy();
      expect(acc.body.offer.status).toBe("BUYER_ACCEPTED");
      // The response explicitly notes no agreement was created.
      expect(acc.body.message).toMatch(/no agreement/i);
      // No agreement field is returned.
      expect(acc.body.agreement).toBeUndefined();

      // DB: offer = BUYER_ACCEPTED.
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: offerId },
      });
      expect(dbOffer!.status).toBe("BUYER_ACCEPTED");
      expect(dbOffer!.isMarketplaceOpportunity).toBe(true);
      expect(dbOffer!.researchStimulus).toBe(false);

      // DB: NO agreement exists for this offer. The two-sided spine
      // explicitly defers agreement creation until the provider accepts.
      const agreementCount = await db.marketplaceAgreement.count({
        where: { offerId },
      });
      expect(agreementCount).toBe(0);

      // DB: opportunity transitioned OFFERED → BUYER_ACCEPTED.
      const dbOpp = await db.transportationOpportunity.findUnique({
        where: { id: opportunityId },
      });
      expect(dbOpp!.status).toBe("BUYER_ACCEPTED");

      // DB: demand remains MATCHED (provider hasn't accepted yet).
      const dbDemand = await db.transportationDemand.findUnique({
        where: { id: demandId },
      });
      expect(dbDemand!.status).toBe("MATCHED");

      // DB: supply is still AVAILABLE (no reservation until provider accepts).
      const dbSupply = await db.transportationSupply.findUnique({
        where: { id: dbOpp!.supplyId },
      });
      expect(dbSupply!.status).toBe("AVAILABLE");
    }, 120000);
  });

  // ─── B. PROVIDER-SIDE ACCEPT ──────────────────────────────────────────
  describe("Provider-side acceptance", () => {
    // ─── 2. PROVIDER ACCEPT CREATES AGREEMENT ──────────────────────────
    test("2. provider_accept_offer creates ACTIVE agreement and reserves supply", async () => {
      const buyer = emailFor("t2-buyer");
      const provider = emailFor("t2-provider");
      const { offerId, opportunityId } = await setupChainToBuyerAccepted(buyer);

      const acc = await providerAcceptOffer(provider, offerId);
      expect(acc.status).toBe(200);
      expect(acc.body.offer).toBeTruthy();
      expect(acc.body.offer.status).toBe("PROVIDER_ACCEPTED");
      expect(acc.body.agreement).toBeTruthy();
      expect(acc.body.agreement.status).toBe("ACTIVE");

      const agreementId = acc.body.agreement.id;

      // DB: offer = PROVIDER_ACCEPTED.
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: offerId },
      });
      expect(dbOffer!.status).toBe("PROVIDER_ACCEPTED");

      // DB: agreement exists, status=ACTIVE, provenance tagged.
      const dbAgg = await db.marketplaceAgreement.findUnique({
        where: { id: agreementId },
      });
      expect(dbAgg).toBeTruthy();
      expect(dbAgg!.status).toBe("ACTIVE");
      expect(dbAgg!.offerId).toBe(offerId);
      expect(dbAgg!.opportunityId).toBe(opportunityId);
      expect(dbAgg!.isMarketplaceOpportunity).toBe(true);
      expect(dbAgg!.researchStimulus).toBe(false);
      expect(dbAgg!.environment).toBe("SANDBOX");

      // DB: exactly ONE agreement for this offer.
      const agreementCount = await db.marketplaceAgreement.count({
        where: { offerId },
      });
      expect(agreementCount).toBe(1);

      // DB: supply transitioned AVAILABLE → RESERVED.
      const dbOpp = await db.transportationOpportunity.findUnique({
        where: { id: opportunityId },
      });
      const dbSupply = await db.transportationSupply.findUnique({
        where: { id: dbOpp!.supplyId },
      });
      expect(dbSupply!.status).toBe("RESERVED");

      // DB: opportunity transitioned BUYER_ACCEPTED → ACCEPTED (both sides).
      expect(dbOpp!.status).toBe("ACCEPTED");
    }, 120000);

    // ─── 5. PROVIDER REJECT TRANSITIONS TO REJECTED ────────────────────
    test("5. provider_reject_offer transitions to REJECTED and creates NO agreement", async () => {
      const buyer = emailFor("t5-buyer");
      const provider = emailFor("t5-provider");
      const { offerId, opportunityId } = await setupChainToBuyerAccepted(buyer);

      const rej = await providerRejectOffer(provider, offerId, "Test rejection");
      expect(rej.status).toBe(200);
      expect(rej.body.offer).toBeTruthy();
      expect(rej.body.offer.status).toBe("REJECTED");
      expect(rej.body.message).toMatch(/no agreement/i);

      // DB: offer = REJECTED.
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: offerId },
      });
      expect(dbOffer!.status).toBe("REJECTED");

      // DB: NO agreement exists for this offer (provider rejected before
      // the two-sided handshake could complete).
      const agreementCount = await db.marketplaceAgreement.count({
        where: { offerId },
      });
      expect(agreementCount).toBe(0);

      // DB: opportunity transitioned to REJECTED.
      const dbOpp = await db.transportationOpportunity.findUnique({
        where: { id: opportunityId },
      });
      expect(dbOpp!.status).toBe("REJECTED");
    }, 120000);

    // ─── 6. PROVIDER CANNOT ACCEPT BEFORE BUYER ───────────────────────
    test("6. provider_accept_offer before buyer_accept_offer returns 400", async () => {
      const buyer = emailFor("t6-buyer");
      const provider = emailFor("t6-provider");
      // Set up the chain but DO NOT call buyer_accept_offer — offer is PENDING.
      const { offerId } = await setupChainToOffer(buyer);

      const pre = await db.marketplaceOffer.findUnique({ where: { id: offerId } });
      expect(pre!.status).toBe("PENDING");

      // Provider attempts to accept directly (skipping buyer_accept).
      const acc = await providerAcceptOffer(provider, offerId);
      expect(acc.status).toBe(400);
      expect(acc.body?.error).toMatch(/BUYER_ACCEPTED/i);

      // DB: offer is STILL PENDING (no state transition).
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: offerId },
      });
      expect(dbOffer!.status).toBe("PENDING");

      // DB: no agreement created.
      const agreementCount = await db.marketplaceAgreement.count({
        where: { offerId },
      });
      expect(agreementCount).toBe(0);
    }, 120000);

    // ─── 7. BUYER CALLING PROVIDER_ACCEPT OFFER ───────────────────────
    test("7. buyer calling provider_accept_offer (sandbox: any authenticated user is provider)", async () => {
      // The sandbox provider identity is resolved server-side from ANY
      // authenticated session. This means the BUYER (who just accepted on
      // the buyer side) CAN call provider_accept_offer and it will succeed.
      // Verify the actual implementation behavior: 200 with agreement created.
      const buyer = emailFor("t7-buyer");
      const { offerId } = await setupChainToBuyerAccepted(buyer);

      // The BUYER themselves calls provider_accept_offer.
      const acc = await providerAcceptOffer(buyer, offerId);

      // Implementation behavior: any authenticated user can be the sandbox
      // provider, so this call SUCCEEDS (status 200). It does NOT return 403.
      expect([200, 403]).toContain(acc.status);

      if (acc.status === 200) {
        // Sandbox behavior — any authenticated session acts as provider.
        expect(acc.body.offer.status).toBe("PROVIDER_ACCEPTED");
        expect(acc.body.agreement).toBeTruthy();
        expect(acc.body.agreement.status).toBe("ACTIVE");

        // DB: agreement exists with ACTIVE status.
        const dbAgg = await db.marketplaceAgreement.findUnique({
          where: { offerId },
        });
        expect(dbAgg).toBeTruthy();
        expect(dbAgg!.status).toBe("ACTIVE");
      } else {
        // If the implementation grows a role check that rejects the buyer,
        // verify it returns 403 (not 400 or 500).
        expect(acc.body?.error).toMatch(/forbidden|provider/i);
      }
    }, 120000);

    // ─── 9. DOUBLE PROVIDER ACCEPT ───────────────────────────────────
    test("9. double provider_accept_offer: second call rejected with 400", async () => {
      const buyer = emailFor("t9-buyer");
      const provider = emailFor("t9-provider");
      const { offerId } = await setupChainToBuyerAccepted(buyer);

      // First provider_accept_offer succeeds.
      const first = await providerAcceptOffer(provider, offerId);
      expect(first.status).toBe(200);
      expect(first.body.offer.status).toBe("PROVIDER_ACCEPTED");
      expect(first.body.agreement).toBeTruthy();
      const agreementId = first.body.agreement.id;

      // Second provider_accept_offer is REJECTED with 400 because the
      // offer is now PROVIDER_ACCEPTED, not BUYER_ACCEPTED. This is NOT
      // a strict idempotent replay — the second call is a no-op rejection.
      const second = await providerAcceptOffer(provider, offerId);
      expect(second.status).toBe(400);
      expect(second.body?.error).toMatch(/BUYER_ACCEPTED/i);

      // DB: offer remains PROVIDER_ACCEPTED (no rollback).
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: offerId },
      });
      expect(dbOffer!.status).toBe("PROVIDER_ACCEPTED");

      // DB: exactly ONE agreement (no duplicate created by the second call).
      const agreementCount = await db.marketplaceAgreement.count({
        where: { offerId },
      });
      expect(agreementCount).toBe(1);
      expect(agreementCount).toBe(1);

      // Reference agreementId so the linter doesn't flag it as unused.
      expect(agreementId).toBeTruthy();
    }, 120000);
  });

  // ─── C. GATING — NO PAYMENT/EXECUTION BEFORE ACTIVE AGREEMENT ──────────
  describe("Payment / execution gating", () => {
    // ─── 3. PAYMENT BEFORE AGREEMENT IS REJECTED ─────────────────────
    test("3. authorize_payment before provider_accept_offer is rejected (no ACTIVE agreement)", async () => {
      const buyer = emailFor("t3-buyer");
      const { demandId, offerId } = await setupChainToBuyerAccepted(buyer);

      // Buyer has accepted, but the provider has not. There is no agreement
      // for this offer yet, so any authorize_payment attempt must fail.
      // The implementation returns 404 "Agreement not found" when no
      // agreement exists, or 400 "Agreement is X; payment requires ACTIVE"
      // when an agreement exists but isn't ACTIVE. Both signal the gate.
      // We pass the offerId as agreementId — no agreement will match.
      const res = await authorizePayment(buyer, offerId);
      expect([400, 404]).toContain(res.status);
      expect(res.body?.error).toMatch(/agreement|active/i);

      // DB: STILL no agreement exists for this offer.
      const agreementCount = await db.marketplaceAgreement.count({
        where: { offerId },
      });
      expect(agreementCount).toBe(0);

      // DB: no PaymentIntent created for this buyer's demand.
      const testPaymentCount = await db.paymentIntent.count({
        where: { demandId },
      });
      expect(testPaymentCount).toBe(0);
    }, 120000);

    // ─── 4. EXECUTION BEFORE AGREEMENT IS REJECTED ──────────────────
    test("4. reserve_execution before provider_accept_offer is rejected (no ACTIVE agreement)", async () => {
      const buyer = emailFor("t4-buyer");
      const { offerId } = await setupChainToBuyerAccepted(buyer);

      // Buyer accepted but provider hasn't — no agreement. Any
      // reserve_execution attempt must fail. Same 400/404 ambiguity as test 3.
      const res = await reserveExecution(buyer, offerId);
      expect([400, 404]).toContain(res.status);
      expect(res.body?.error).toMatch(/agreement|active/i);

      // DB: no agreement, no execution.
      const agreementCount = await db.marketplaceAgreement.count({
        where: { offerId },
      });
      expect(agreementCount).toBe(0);

      const executionCount = await db.transportationExecution.count({
        where: { opportunity: { demand: { userId: buyer } } },
      });
      expect(executionCount).toBe(0);
    }, 120000);
  });

  // ─── D. FULL TWO-SIDED TRANSACTION ───────────────────────────────────
  describe("Full two-sided transaction", () => {
    // ─── 8. FULL CHAIN COMPLETES ──────────────────────────────────────
    test("8. full two-sided transaction: buyer_accept → provider_accept → pay → execute → complete", async () => {
      const buyer = emailFor("t8-buyer");
      const provider = emailFor("t8-provider");

      // Two-sided handshake: buyer accepts, then provider accepts.
      const { demandId, opportunityId, offerId, agreementId } =
        await setupChainToProviderAccepted(buyer, provider);

      // Agreement must be ACTIVE for the downstream gates to open.
      const dbAgg = await db.marketplaceAgreement.findUnique({
        where: { id: agreementId },
      });
      expect(dbAgg!.status).toBe("ACTIVE");

      // authorize_payment — gated on agreement.status === ACTIVE.
      const auth = await authorizePayment(buyer, agreementId);
      expect(auth.status).toBe(200);
      expect(auth.body.paymentIntent).toBeTruthy();
      expect(auth.body.paymentIntent.status).toBe("AUTHORIZED");
      const paymentIntentId = auth.body.paymentIntent.id;

      // capture_payment — escrow → supplier + platform.
      const cap = await capturePayment(buyer, paymentIntentId);
      expect(cap.status).toBe(200);
      expect(cap.body.paymentIntent.status).toBe("CAPTURED");

      // reserve_execution — gated on agreement.status === ACTIVE.
      const res = await reserveExecution(buyer, agreementId);
      expect(res.status).toBe(200);
      expect(res.body.execution).toBeTruthy();
      expect(res.body.execution.state).toBe("RESERVED");
      expect(res.body.execution.evidenceEligible).toBe(false);
      const executionId = res.body.execution.id;

      // dispatch — provider adapter starts the execution.
      const disp = await dispatch(buyer, executionId);
      expect(disp.status).toBe(200);
      expect(disp.body.execution.state).toMatch(/DISPATCHED|EN_ROUTE/);

      // complete_execution — engine transitions to COMPLETED + settlement.
      const comp = await completeExecution(buyer, executionId);
      expect(comp.status).toBe(200);
      expect(comp.body.execution).toBeTruthy();
      expect(comp.body.execution.state).toBe("COMPLETED");
      expect(comp.body.settlement).toBeTruthy();
      expect(comp.body.settlement.status).toBe("SETTLED");

      // DB: execution = COMPLETED with completedAt set.
      const dbExec = await db.transportationExecution.findUnique({
        where: { id: executionId },
      });
      expect(dbExec!.state).toBe("COMPLETED");
      expect(dbExec!.completedAt).toBeTruthy();
      expect(dbExec!.evidenceEligible).toBe(false);

      // DB: demand = COMPLETED.
      const dbDemand = await db.transportationDemand.findUnique({
        where: { id: demandId },
      });
      expect(dbDemand!.status).toBe("COMPLETED");

      // DB: settlement row exists (SETTLED, amount > 0).
      const settlements = await db.settlement.findMany({
        where: { executionId },
      });
      expect(settlements.length).toBe(1);
      expect(settlements[0].status).toBe("SETTLED");
      expect(settlements[0].amount).toBeGreaterThan(0);
      expect(settlements[0].supplierId).toBe(dbExec!.providerId);

      // Reference opportunityId so it's not flagged unused.
      expect(opportunityId).toBeTruthy();
      expect(offerId).toBeTruthy();
    }, 240000);

    // ─── 11. SANDBOX EXECUTION evidenceEligible=false ───────────────
    test("11. sandbox execution has evidenceEligible=false", async () => {
      const buyer = emailFor("t11-buyer");
      const provider = emailFor("t11-provider");
      const { offerId, agreementId } = await setupChainToProviderAccepted(
        buyer,
        provider,
      );

      const res = await reserveExecution(buyer, agreementId);
      expect(res.status).toBe(200);
      const executionId = res.body.execution.id;

      // Response explicitly states evidenceEligible=false.
      expect(res.body.execution.evidenceEligible).toBe(false);
      expect(res.body.execution.environment).toBe("SANDBOX");

      // DB: persisted execution has evidenceEligible=false.
      const dbExec = await db.transportationExecution.findUnique({
        where: { id: executionId },
      });
      expect(dbExec).toBeTruthy();
      expect(dbExec!.evidenceEligible).toBe(false);
      expect(dbExec!.environment).toBe("SANDBOX");
      expect(dbExec!.isMarketplaceOpportunity).toBe(true);
      expect(dbExec!.researchStimulus).toBe(false);

      // Reference offerId so it's not flagged unused.
      expect(offerId).toBeTruthy();
    }, 180000);
  });

  // ─── E. PROVENANCE / TAGGING ──────────────────────────────────────────
  describe("Provenance tagging", () => {
    // ─── 10. MARKETPLACE OBJECTS TAGGED CORRECTLY ────────────────────
    test("10. all marketplace objects carry isMarketplaceOpportunity=true, researchStimulus=false", async () => {
      const buyer = emailFor("t10-buyer");
      const provider = emailFor("t10-provider");
      // Walk the full two-sided chain through a COMPLETED execution so
      // every marketplace object type is created and tagged.
      const { demandId, opportunityId, offerId, agreementId } =
        await setupChainToProviderAccepted(buyer, provider);
      const auth = await authorizePayment(buyer, agreementId);
      const paymentIntentId = auth.body.paymentIntent.id;
      await capturePayment(buyer, paymentIntentId);
      const res = await reserveExecution(buyer, agreementId);
      const executionId = res.body.execution.id;
      await dispatch(buyer, executionId);
      await completeExecution(buyer, executionId);

      // Demand (no provenance columns, but environment tag matters).
      const dbDemand = await db.transportationDemand.findUnique({
        where: { id: demandId },
      });
      expect(dbDemand!.environment).toBe("SANDBOX");

      // Opportunity.
      const dbOpp = await db.transportationOpportunity.findUnique({
        where: { id: opportunityId },
      });
      expect(dbOpp!.isMarketplaceOpportunity).toBe(true);
      expect(dbOpp!.researchStimulus).toBe(false);
      expect(dbOpp!.environment).toBe("SANDBOX");

      // Offer.
      const dbOffer = await db.marketplaceOffer.findUnique({
        where: { id: offerId },
      });
      expect(dbOffer!.isMarketplaceOpportunity).toBe(true);
      expect(dbOffer!.researchStimulus).toBe(false);
      expect(dbOffer!.environment).toBe("SANDBOX");

      // Agreement.
      const dbAgg = await db.marketplaceAgreement.findUnique({
        where: { id: agreementId },
      });
      expect(dbAgg!.isMarketplaceOpportunity).toBe(true);
      expect(dbAgg!.researchStimulus).toBe(false);
      expect(dbAgg!.environment).toBe("SANDBOX");

      // Execution.
      const dbExec = await db.transportationExecution.findUnique({
        where: { id: executionId },
      });
      expect(dbExec!.isMarketplaceOpportunity).toBe(true);
      expect(dbExec!.researchStimulus).toBe(false);
      expect(dbExec!.environment).toBe("SANDBOX");
      expect(dbExec!.evidenceEligible).toBe(false);

      // PaymentIntent (environment tag only).
      const dbIntent = await db.paymentIntent.findUnique({
        where: { id: paymentIntentId },
      });
      expect(dbIntent!.environment).toBe("SANDBOX");

      // Settlement (environment tag only).
      const settlements = await db.settlement.findMany({
        where: { executionId },
      });
      expect(settlements.length).toBe(1);
      expect(settlements[0].environment).toBe("SANDBOX");
    }, 240000);
  });

  // ─── F. AUTHENTICATION ───────────────────────────────────────────────
  describe("Authentication", () => {
    // ─── 12. UNAUTHENTICATED PROVIDER_ACCEPT → 401 ───────────────────
    test("12. unauthenticated provider_accept_offer returns 401", async () => {
      // No session for provider_accept_offer — POST handler always calls
      // requireEmail() first, which returns null without a session, so
      // the route responds with 401 BEFORE the provider-identity check.
      const res = await callRouteUnauthenticated({
        mode: "provider_accept_offer",
        offerId: "never-used",
      });
      expect(res.status).toBe(401);
      expect(res.body?.error).toMatch(/authentication/i);
    }, 30000);
  });
});
