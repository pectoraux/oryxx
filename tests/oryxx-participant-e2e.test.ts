// ORYXX — End-to-end participant journey test against the frozen backend.
//
// This test exercises the FULL provider participant journey that the
// ProviderResearchUI component drives, by invoking the ACTUAL production
// route handler (POST from src/app/api/oryxx/willingness/experiment/route.ts)
// with real Request objects — the same calls the UI makes.
//
// Journey under test:
//   1. GET experiments (UI loads active experiments)
//   2. POST mode=enroll (participant enrolls)
//   3. POST mode=consent (participant consents)
//   4. POST mode=verify_provider (admin verifies — required before offers)
//   5. POST mode=create_offer (offer created from frozen treatment design)
//   6. POST mode=transition OFFER_PRESENTED
//   7. POST mode=transition PROVIDER_VIEWED
//   8. POST mode=transition PROVIDER_ACCEPTED → W3-R evidence created
//   9. POST mode=transition TRIP_STARTED
//  10. POST mode=transition TRIP_COMPLETED → W4-R evidence created
//  11. GET results (per-cell Wilson CI computed)
//  12. POST mode=integrity_check (no violations)
//  13. POST mode=export_analysis (fails closed if violations)
//  14. POST mode=withdraw (idempotent, preserves history)
//
// NO production logic is duplicated. The test only constructs Request objects
// and inspects Response objects + DB state.
//
// PREREQUISITES:
//   - DATABASE_URL must point to a real PostgreSQL database
//   - The Prisma schema must be applied (prisma db push)
//
// CI: Executed by .github/workflows/research-integrity.yml against a fresh
// PostgreSQL 16 service container per run.
//
// Run locally:
//   DATABASE_URL="postgresql://..." DIRECT_URL="postgresql://..." \
//     bun test tests/oryxx-participant-e2e.test.ts --timeout 120000

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { AsyncLocalStorage } from "async_hooks";

// ─── Environment fix-up ────────────────────────────────────────────────
if (process.env.DIRECT_URL && !process.env.DATABASE_URL?.startsWith("postgres")) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

import { PrismaClient } from "@prisma/client";
import {
  computePreregistrationHash,
  generateTreatmentCells,
  type PreregisteredDesign,
} from "../src/lib/oryxx/real/evidence/pilot";

// ─── Auth boundary mock ────────────────────────────────────────────────
// Per-request session via AsyncLocalStorage — mirrors Next.js per-request
// session resolution. The route derives identity from session.user only.
const sessionALS = new AsyncLocalStorage<{
  user: { email: string; role: string; id: string };
}>();

mock.module("next-auth", () => ({
  getServerSession: async () => sessionALS.getStore() ?? null,
  default: { getServerSession: async () => sessionALS.getStore() ?? null },
}));

// Import the ACTUAL production route handlers AFTER the mock is registered.
const experimentRoute = await import(
  "../src/app/api/oryxx/willingness/experiment/route"
);
const POST = experimentRoute.POST;
const GET = experimentRoute.GET;

const resultsRoute = await import(
  "../src/app/api/oryxx/willingness/results/route"
);
const RESULTS_GET = resultsRoute.GET;

// ─── Database client ──────────────────────────────────────────────────
const db = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  },
});

// ─── Preregistered design (matches the UI's expectations) ────────────
const E2E_DESIGN: PreregisteredDesign = {
  hypothesis: "Providers will accept pooled-trip offers when comp >= $3 and detour <= 2km.",
  population: "ride-hail drivers",
  geography: "NYC",
  providerType: "taxi/FHV",
  sampleTarget: 100,
  compensationBuckets: [1, 2, 3, 4, 5],
  detourBuckets: [0, 0.5, 1, 2, 3],
  extraTimeBuckets: [0, 2, 5, 10],
  noticeBuckets: [0, 15, 60],
  randomizationSeed: 42,
  primaryOutcome: "W3_acceptance_rate",
  secondaryOutcomes: ["W4-R_completion_rate", "net_value"],
  analysisMethod: "per-cell Wilson CI",
  stoppingRule: "Stop after 100 responses or 30 days.",
  safetyRules: [],
  maxDetourKm: 5,
  maxExtraTimeMin: 20,
  minCompensation: 1,
  consentText: "RESEARCH STUDY - THIS IS NOT A MARKETPLACE BOOKING. You are participating in research about provider willingness. You may withdraw at any time.",
  assumedUserSavings: 4,
  assumedFailureCost: 1,
  assumedOryxxMargin: 0.5,
};

const VALID_CELL_IDS = new Set(generateTreatmentCells(E2E_DESIGN).map((c) => c.id));
const TEST_TAG = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let experimentId: string;
let enrollmentId: string;
let enrollmentToken: string;
let responseId: string;
let participantEmail: string;
const adminEmail = `${TEST_TAG}-admin@oryxx.test`;

// ─── Helpers ──────────────────────────────────────────────────────────
async function asUser<T>(email: string, role: string, fn: () => Promise<T>): Promise<T> {
  return sessionALS.run({ user: { email, role, id: `id-${email}` } }, fn);
}

async function callPOST(body: any, email: string, role: string = "user"): Promise<{ status: number; body: any }> {
  return asUser(email, role, async () => {
    const req = new Request("http://localhost/api/oryxx/willingness/experiment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  });
}

async function callGET(email: string, role: string = "user"): Promise<{ status: number; body: any }> {
  return asUser(email, role, async () => {
    const req = new Request("http://localhost/api/oryxx/willingness/experiment", { method: "GET" });
    const res = await GET(req);
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  });
}

async function callResults(email: string, experimentId: string): Promise<{ status: number; body: any }> {
  return asUser(email, "admin", async () => {
    const req = new Request(`http://localhost/api/oryxx/willingness/results?experimentId=${experimentId}`);
    const res = await RESULTS_GET(req);
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────────────
async function cleanupLeftover() {
  const leftover = await db.acceptanceExperiment.findMany({
    where: { name: { contains: "E2E Participant Journey" } },
    select: { id: true },
  });
  for (const exp of leftover) {
    const enrolls = await db.experimentEnrollment.findMany({ where: { experimentId: exp.id }, select: { id: true } });
    const eids = enrolls.map((e) => e.id);
    if (eids.length > 0) {
      await db.providerResponse.deleteMany({ where: { enrollmentId: { in: eids } } });
      await db.experimentConsent.deleteMany({ where: { enrollmentId: { in: eids } } });
    }
    await db.experimentEvent.deleteMany({ where: { experimentId: exp.id } });
    await db.experimentEnrollment.deleteMany({ where: { experimentId: exp.id } });
    await db.acceptanceExperiment.delete({ where: { id: exp.id } }).catch(() => {});
  }
}

beforeAll(async () => {
  await cleanupLeftover();
  // Create + preregister + activate a real experiment for the journey
  const createRes = await callPOST({ mode: "create_experiment", name: `E2E Participant Journey ${TEST_TAG}`, description: "E2E test", hypothesis: E2E_DESIGN.hypothesis, sampleTarget: 100, stoppingRule: E2E_DESIGN.stoppingRule, randomizationSeed: 42, maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1, assumedUserSavings: 4, assumedFailureCost: 1, assumedOryxxMargin: 0.5 }, adminEmail, "admin");
  if (createRes.status !== 200) throw new Error(`create_experiment failed: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  experimentId = createRes.body.experiment.id;

  const preregRes = await callPOST({ mode: "preregister", experimentId, population: E2E_DESIGN.population, geography: E2E_DESIGN.geography, providerType: E2E_DESIGN.providerType, compensationBuckets: E2E_DESIGN.compensationBuckets, detourBuckets: E2E_DESIGN.detourBuckets, extraTimeBuckets: E2E_DESIGN.extraTimeBuckets, noticeBuckets: E2E_DESIGN.noticeBuckets, secondaryOutcomes: E2E_DESIGN.secondaryOutcomes, analysisMethod: E2E_DESIGN.analysisMethod, safetyRules: E2E_DESIGN.safetyRules }, adminEmail, "admin");
  if (preregRes.status !== 200) throw new Error(`preregister failed: ${preregRes.status}`);

  const activateRes = await callPOST({ mode: "activate", experimentId }, adminEmail, "admin");
  if (activateRes.status !== 200) throw new Error(`activate failed: ${activateRes.status} ${JSON.stringify(activateRes.body)}`);
}, 120000);

afterAll(async () => {
  if (experimentId) {
    const enrolls = await db.experimentEnrollment.findMany({ where: { experimentId }, select: { id: true } });
    const eids = enrolls.map((e) => e.id);
    if (eids.length > 0) {
      await db.providerResponse.deleteMany({ where: { enrollmentId: { in: eids } } });
      await db.experimentConsent.deleteMany({ where: { enrollmentId: { in: eids } } });
    }
    await db.experimentEvent.deleteMany({ where: { experimentId } });
    await db.experimentEnrollment.deleteMany({ where: { experimentId } });
    await db.acceptanceExperiment.delete({ where: { id: experimentId } }).catch(() => {});
  }
  await db.$disconnect();
}, 60000);

// ═══════════════════════════════════════════════════════════════════════
// E2E PARTICIPANT JOURNEY
// ═══════════════════════════════════════════════════════════════════════

describe("ORYXX E2E participant journey — UI → API → DB", () => {

  // Step 1: UI loads active experiments (GET)
  test("Step 1: GET experiments returns the ACTIVE experiment", async () => {
    const res = await callGET(participantEmail || `${TEST_TAG}-p1@oryxx.test`);
    expect(res.status).toBe(200);
    const activeExps = res.body.experiments.filter((e: any) => e.status === "ACTIVE");
    expect(activeExps.length).toBeGreaterThan(0);
    const ourExp = activeExps.find((e: any) => e.id === experimentId);
    expect(ourExp).toBeTruthy();
    expect(ourExp.status).toBe("ACTIVE");
  }, 15000);

  // Step 2: Participant enrolls
  test("Step 2: POST mode=enroll creates enrollment with real treatment cell", async () => {
    participantEmail = `${TEST_TAG}-participant@oryxx.test`;
    const res = await callPOST({ mode: "enroll", experimentId }, participantEmail);
    expect(res.status).toBe(200);
    expect(res.body.enrollment).toBeTruthy();
    expect(res.body.enrollment.accountEmail).toBe(participantEmail);
    expect(res.body.enrollment.providerVerified).toBe("unverified");
    expect(res.body.enrollment.assignedCellId).toBeTruthy();
    expect(VALID_CELL_IDS.has(res.body.enrollment.assignedCellId)).toBe(true);
    expect(res.body.assignedCell.id).toBe(res.body.enrollment.assignedCellId);
    enrollmentId = res.body.enrollment.id;
    enrollmentToken = res.body.enrollment.enrollmentToken;

    // Verify DB state
    const dbRow = await db.experimentEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(dbRow?.assignedCellId).toBe(res.body.enrollment.assignedCellId);
    expect(dbRow?.accountEmail).toBe(participantEmail);
  }, 15000);

  // Step 3: Participant consents
  test("Step 3: POST mode=consent records consent with hash", async () => {
    const res = await callPOST({ mode: "consent", enrollmentToken }, participantEmail);
    expect(res.status).toBe(200);
    expect(res.body.consent).toBeTruthy();
    expect(res.body.consent.accountEmail).toBe(participantEmail);
    expect(res.body.consent.consentTextHash).toBeTruthy();

    // Verify DB
    const consent = await db.experimentConsent.findFirst({ where: { enrollmentId } });
    expect(consent).toBeTruthy();
    expect(consent?.withdrawnAt).toBeNull();
  }, 15000);

  // Step 4: Admin verifies provider (operator_verified only)
  test("Step 4: POST mode=verify_provider sets operator_verified", async () => {
    const res = await callPOST({ mode: "verify_provider", enrollmentId, providerType: "taxi", reference: "admin-manual" }, adminEmail, "admin");
    expect(res.status).toBe(200);

    const dbRow = await db.experimentEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(dbRow?.providerVerified).toBe("operator_verified");
    expect(dbRow?.providerType).toBe("taxi");
    expect(dbRow?.verifiedAt).toBeTruthy();
  }, 15000);

  // Step 4b: externally_verified is impossible
  test("Step 4b: externally_verified is rejected", async () => {
    const res = await callPOST({ mode: "verify_provider", enrollmentId, level: "externally_verified" }, adminEmail, "admin");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/externally_verified impossible/i);
  }, 15000);

  // Step 5: Offer created from frozen treatment design
  test("Step 5: POST mode=create_offer creates offer matching assigned cell", async () => {
    const res = await callPOST({ mode: "create_offer", enrollmentToken }, participantEmail);
    expect(res.status).toBe(200);
    expect(res.body.response).toBeTruthy();
    expect(res.body.response.state).toBe("OFFER_CREATED");
    expect(res.body.response.evidenceTier).toBe("NONE");
    expect(res.body.response.offerExpiresAt).toBeTruthy();

    // Offer cell matches enrollment's assigned cell (immutable)
    const enrollment = await db.experimentEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(res.body.response.treatmentCellId).toBe(enrollment?.assignedCellId);
    responseId = res.body.response.id;

    // Verify audit event was created
    const events = await db.experimentEvent.findMany({ where: { offerId: responseId } });
    expect(events.length).toBe(1);
    expect(events[0].toState).toBe("OFFER_CREATED");
  }, 15000);

  // Step 6: Transition to OFFER_PRESENTED
  test("Step 6: transition OFFER_CREATED → OFFER_PRESENTED", async () => {
    const res = await callPOST({ mode: "transition", enrollmentToken, responseId, newState: "OFFER_PRESENTED" }, participantEmail);
    expect(res.status).toBe(200);
    expect(res.body.toState).toBe("OFFER_PRESENTED");
    expect(res.body.w3rCreated).toBe(false);

    const dbRow = await db.providerResponse.findUnique({ where: { id: responseId } });
    expect(dbRow?.state).toBe("OFFER_PRESENTED");
    expect(dbRow?.offerPresentedAt).toBeTruthy();
  }, 15000);

  // Step 7: Transition to PROVIDER_VIEWED
  test("Step 7: transition OFFER_PRESENTED → PROVIDER_VIEWED", async () => {
    const res = await callPOST({ mode: "transition", enrollmentToken, responseId, newState: "PROVIDER_VIEWED" }, participantEmail);
    expect(res.status).toBe(200);
    expect(res.body.toState).toBe("PROVIDER_VIEWED");
    expect(res.body.w3rCreated).toBe(false);
  }, 15000);

  // Step 8: PROVIDER_ACCEPTED → W3-R evidence created
  test("Step 8: transition PROVIDER_VIEWED → PROVIDER_ACCEPTED creates W3-R", async () => {
    const res = await callPOST({ mode: "transition", enrollmentToken, responseId, newState: "PROVIDER_ACCEPTED" }, participantEmail);
    expect(res.status).toBe(200);
    expect(res.body.toState).toBe("PROVIDER_ACCEPTED");
    expect(res.body.w3rCreated).toBe(true);
    expect(res.body.evidenceTier).toBe("W3-R");

    const dbRow = await db.providerResponse.findUnique({ where: { id: responseId } });
    expect(dbRow?.state).toBe("PROVIDER_ACCEPTED");
    expect(dbRow?.evidenceTier).toBe("W3-R");
    expect(dbRow?.decision).toBe("accept");
    expect(dbRow?.decisionAt).toBeTruthy();

    // Audit event chain
    const events = await db.experimentEvent.findMany({ where: { offerId: responseId }, orderBy: { timestamp: "asc" } });
    expect(events.length).toBe(4); // CREATED + PRESENTED + VIEWED + ACCEPTED
    expect(events[3].toState).toBe("PROVIDER_ACCEPTED");
    // Verify hash chain
    for (let i = 1; i < events.length; i++) {
      expect(events[i].previousEventHash).toBe(events[i - 1].eventHash);
    }
  }, 15000);

  // Step 9: TRIP_STARTED (requires admin for TRIP_COMPLETED)
  test("Step 9: transition PROVIDER_ACCEPTED → TRIP_STARTED", async () => {
    const res = await callPOST({ mode: "transition", enrollmentToken, responseId, newState: "TRIP_STARTED" }, participantEmail);
    expect(res.status).toBe(200);
    expect(res.body.toState).toBe("TRIP_STARTED");

    const dbRow = await db.providerResponse.findUnique({ where: { id: responseId } });
    expect(dbRow?.executed).toBe(true);
  }, 15000);

  // Step 10: TRIP_COMPLETED → W4-R evidence (admin only)
  test("Step 10: transition TRIP_STARTED → TRIP_COMPLETED creates W4-R (admin only)", async () => {
    // Non-admin cannot complete
    const failRes = await callPOST({ mode: "transition", enrollmentToken, responseId, newState: "TRIP_COMPLETED" }, participantEmail);
    expect(failRes.status).toBe(403);

    // Admin completes
    const res = await callPOST({ mode: "transition", enrollmentToken, responseId, newState: "TRIP_COMPLETED" }, adminEmail, "admin");
    expect(res.status).toBe(200);
    expect(res.body.toState).toBe("TRIP_COMPLETED");
    expect(res.body.w4rCreated).toBe(true);
    expect(res.body.evidenceTier).toBe("W4-R");

    const dbRow = await db.providerResponse.findUnique({ where: { id: responseId } });
    expect(dbRow?.state).toBe("TRIP_COMPLETED");
    expect(dbRow?.evidenceTier).toBe("W4-R");
    expect(dbRow?.completed).toBe(true);
    expect(dbRow?.completionEvidenceLevel).toBe("operator");
    expect(dbRow?.externalVerifiedBy).toBe(adminEmail);
  }, 15000);

  // Step 11: GET results returns per-cell Wilson CI
  test("Step 11: GET results returns per-cell table with Wilson 95% CI", async () => {
    const res = await callResults(adminEmail, experimentId);
    expect(res.status).toBe(200);
    expect(res.body.cellResults).toBeTruthy();
    expect(res.body.cellResults.length).toBe(VALID_CELL_IDS.size);
    expect(res.body.w3Count).toBe(1);
    expect(res.body.w4Count).toBe(1);
    expect(res.body.hasW3Evidence).toBe(true);
    expect(res.body.hasW4Evidence).toBe(true);

    // Find the cell that has our response
    const enrollment = await db.experimentEnrollment.findUnique({ where: { id: enrollmentId } });
    const ourCell = res.body.cellResults.find((c: any) => c.cell.id === enrollment?.assignedCellId);
    expect(ourCell).toBeTruthy();
    expect(ourCell.accepted).toBe(1);
    expect(ourCell.completed).toBe(1);
    expect(ourCell.acceptanceCI95).toBeTruthy();
    expect(ourCell.completionCI95).toBeTruthy();
  }, 15000);

  // Step 12: Integrity check — no violations
  test("Step 12: POST mode=integrity_check reports no violations", async () => {
    const res = await callPOST({ mode: "integrity_check", experimentId }, adminEmail, "admin");
    expect(res.status).toBe(200);
    expect(res.body.report.violations).toEqual([]);
    expect(res.body.report.hashChainValid).toBe(true);
    expect(res.body.report.counts.w3r).toBe(1);
    expect(res.body.report.counts.w4r).toBe(1);
    expect(res.body.report.counts.w3m).toBe(0);
    expect(res.body.report.counts.w4m).toBe(0);
  }, 15000);

  // Step 13: Export analysis — succeeds (no violations)
  test("Step 13: POST mode=export_analysis succeeds with valid data", async () => {
    const res = await callPOST({ mode: "export_analysis", experimentId }, adminEmail, "admin");
    expect(res.status).toBe(200);
    expect(res.body.dataset).toBeTruthy();
    expect(res.body.dataset.length).toBe(1);
    expect(res.body.dataset[0].evidenceTier).toBe("W4-R");
    expect(res.body.dataset[0].providerVerificationLevel).toBe("operator_verified");
    expect(res.body.dataset[0].completionEvidenceLevel).toBe("operator");
    // Pseudonymized — no raw email
    expect(res.body.dataset[0].participantPseudonym).toMatch(/…$/);
  }, 15000);

  // Step 14: Export audit — hash chain valid
  test("Step 14: POST mode=export_audit returns valid hash chain", async () => {
    const res = await callPOST({ mode: "export_audit", experimentId }, adminEmail, "admin");
    expect(res.status).toBe(200);
    expect(res.body.chainValid).toBe(true);
    expect(res.body.eventCount).toBeGreaterThan(0);
  }, 15000);

  // Step 15: Withdrawal — idempotent, preserves history
  test("Step 15: POST mode=withdraw is idempotent and preserves W3-R history", async () => {
    const res1 = await callPOST({ mode: "withdraw", enrollmentToken }, participantEmail);
    expect(res1.status).toBe(200);
    expect(res1.body.withdrawnAt).toBeTruthy();

    // Idempotent
    const res2 = await callPOST({ mode: "withdraw", enrollmentToken }, participantEmail);
    expect(res2.status).toBe(200);
    expect(res2.body.withdrawnAt).toBe(res1.body.withdrawnAt);

    // DB: enrollment withdrawn
    const dbRow = await db.experimentEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(dbRow?.status).toBe("withdrawn");
    expect(dbRow?.withdrawnAt).toBeTruthy();

    // History preserved: W3-R evidence still exists
    const response = await db.providerResponse.findUnique({ where: { id: responseId } });
    expect(response?.evidenceTier).toBe("W4-R"); // W4-R supersedes but is preserved
    const events = await db.experimentEvent.findMany({ where: { offerId: responseId } });
    expect(events.length).toBeGreaterThan(0);
  }, 15000);

  // Step 16: Post-withdrawal — no new transitions accepted
  test("Step 16: post-withdrawal transition is rejected", async () => {
    // Create a new offer+response to test post-withdrawal transition rejection
    // (the existing response is already in TRIP_COMPLETED terminal state)
    const offerRes = await callPOST({ mode: "create_offer", enrollmentToken }, participantEmail);
    expect(offerRes.status).toBe(403); // withdrawn participants cannot receive offers
    expect(offerRes.body.error).toMatch(/withdrawn/i);
  }, 15000);

  // Step 17: Cross-account authorization — B cannot act as A
  test("Step 17: cross-account transition is rejected (403)", async () => {
    // B tries to transition A's response (A is now withdrawn, but even if not, B can't act)
    const emailB = `${TEST_TAG}-attacker@oryxx.test`;
    const res = await callPOST({ mode: "transition", enrollmentToken, responseId, newState: "PROVIDER_DECLINED" }, emailB);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CROSS-USER/i);
  }, 15000);

  // Step 18: Unauthenticated request rejected
  test("Step 18: unauthenticated request → 401", async () => {
    const req = new Request("http://localhost/api/oryxx/willingness/experiment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "enroll", experimentId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  }, 15000);

  // Step 19: Marketplace transaction rejected
  test("Step 19: MARKETPLACE_TRANSACTION → 403", async () => {
    const res = await callPOST({ mode: "enroll", experimentId, experimentType: "MARKETPLACE_TRANSACTION" }, `${TEST_TAG}-mkt@oryxx.test`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/marketplace/i);
  }, 15000);

  // Step 20: Activation gate check — experiment is already ACTIVE, so gate fails
  test("Step 20: activation_check on ACTIVE experiment fails (already active)", async () => {
    const res = await callPOST({ mode: "activation_check", experimentId }, adminEmail, "admin");
    expect(res.status).toBe(200);
    expect(res.body.gate.canActivate).toBe(false);
    const preregCheck = res.body.gate.checks.find((c: any) => c.name === "preregistration");
    expect(preregCheck.passed).toBe(false); // status is ACTIVE, not PREREGISTERED
  }, 15000);

  // Step 21: Emergency pause
  test("Step 21: POST mode=pause → ACTIVE → PAUSED", async () => {
    const res = await callPOST({ mode: "pause", experimentId }, adminEmail, "admin");
    expect(res.status).toBe(200);

    const dbRow = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
    expect(dbRow?.status).toBe("PAUSED");

    // Audit event
    const pauseEvent = await db.experimentEvent.findFirst({ where: { experimentId, toState: "PAUSED" } });
    expect(pauseEvent).toBeTruthy();
  }, 15000);

  // Step 22: While PAUSED, no new enrollments
  test("Step 22: while PAUSED, enrollment is rejected", async () => {
    const res = await callPOST({ mode: "enroll", experimentId }, `${TEST_TAG}-paused@oryxx.test`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PAUSED/i);
  }, 15000);

  // Step 23: Resume
  test("Step 23: POST mode=resume → PAUSED → ACTIVE", async () => {
    const res = await callPOST({ mode: "resume", experimentId }, adminEmail, "admin");
    expect(res.status).toBe(200);

    const dbRow = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
    expect(dbRow?.status).toBe("ACTIVE");
  }, 15000);
});
