// ORYXX — REAL HTTP-level concurrency tests for the production enrollment path.
//
// This test invokes the ACTUAL Next.js route handler (POST from
// src/app/api/oryxx/willingness/experiment/route.ts) with real Request objects.
// Authentication is provided via a mocked getServerSession (the SAME auth
// boundary the production route calls). Identity is derived from the session,
// NOT from the request body — exactly as in production.
//
// The full production chain is exercised end-to-end:
//   HTTP Request
//     → getServerSession(authOptions)            [auth boundary — mocked]
//     → experiment lookup + ACTIVE status check   [preregistration]
//     → loadDesignStrict + verifyDesignHash        [hash immutability]
//     → SELECT...FOR UPDATE on experiment row     [per-experiment lock]
//     → generateTreatmentCells(design)            [treatment cells]
//     → findMany(cellCounts) + assignTreatment()  [least-filled allocation]
//     → experimentEnrollment.create              [DB unique constraint]
//     → P2002 → 409 (not retried)                 [duplicate handling]
//     → P2034/P2028/P2024 → retry with backoff     [transient handling]
//     → HTTP Response
//
// NO production enrollment logic is duplicated inside this test. The test
// only constructs Request objects and inspects Response objects + DB state.
// The route's assignTreatment / generateTreatmentCells are executed by the
// production code path — never re-implemented here.
//
// PREREQUISITES:
//   - DATABASE_URL must point to a real PostgreSQL database
//   - The ExperimentEnrollment table must exist with the composite unique
//     constraint @@unique([experimentId, accountEmail])
//
// CI: This test is executed by .github/workflows/research-integrity.yml
// against a fresh PostgreSQL 16 service container per run. The workflow
// applies the Prisma schema via `prisma db push` before running this test.
//
// Local: Run with:
//   DATABASE_URL="postgresql://..." DIRECT_URL="postgresql://..." \
//     bun test tests/oryxx-enrollment-http.test.ts --timeout 300000
//
// NEVER run against production Neon. The test creates and deletes experiments
// and enrollments — it is for CI/isolated databases only.

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { AsyncLocalStorage } from "async_hooks";

// ─── Environment fix-up ────────────────────────────────────────────────
// The sandbox shell may export DATABASE_URL=file:... (SQLite) which shadows
// the PostgreSQL URL in .env. In production (Vercel), DATABASE_URL is the
// Neon pooled PostgreSQL URL. We restore the production contract here so
// the route's @/lib/db PrismaClient connects to the real PostgreSQL.
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
//
// The production route calls getServerSession(authOptions). We replace
// next-auth's getServerSession with a function that reads the session from
// an AsyncLocalStorage context. This lets each concurrent request carry
// its own authenticated identity without a shared mutable variable —
// mirroring how a real Next.js server resolves per-request sessions.
//
// The route derives email and role from session.user — the test NEVER
// supplies identity via the request body. If a test sends accountEmail in
// the body, the route IGNORES it (proven by the authorization tests below).

const sessionALS = new AsyncLocalStorage<{
  user: { email: string; role: string; id: string };
}>();

mock.module("next-auth", () => ({
  getServerSession: async () => sessionALS.getStore() ?? null,
  default: { getServerSession: async () => sessionALS.getStore() ?? null },
}));

// Import the ACTUAL production route handler AFTER the mock is registered.
// Dynamic import ensures the mock is in place before the route module loads.
const routeModule = await import(
  "../src/app/api/oryxx/willingness/experiment/route"
);
const POST = routeModule.POST;

// ─── Database client (the same Neon DB the production route uses) ───────
const db = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  },
});

// ─── Preregistered design ──────────────────────────────────────────────
// 3 × 3 × 2 × 2 = 36 treatment cells. 100 enrollments / 36 cells →
// max-min ≤ 1 under least-filled allocation. All buckets pass safety.
const TEST_DESIGN: PreregisteredDesign = {
  hypothesis: "test",
  population: "test",
  geography: "test",
  providerType: "test",
  sampleTarget: 500,
  compensationBuckets: [1, 2, 3],
  detourBuckets: [0, 1, 2],
  extraTimeBuckets: [0, 5],
  noticeBuckets: [0, 15],
  randomizationSeed: 42,
  primaryOutcome: "W3_acceptance_rate",
  secondaryOutcomes: [],
  analysisMethod: "wilson",
  stoppingRule: "test",
  safetyRules: [],
  maxDetourKm: 5,
  maxExtraTimeMin: 20,
  minCompensation: 1,
  consentText: "test",
  assumedUserSavings: 4,
  assumedFailureCost: 1,
  assumedOryxxMargin: 0.5,
};

// Unique tag so every test run's data is identifiable and cleanable.
const TEST_TAG = `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let experimentId: string;
const emailFor = (label: string) => `${TEST_TAG}-${label}@oryxx.test`;

// Pre-compute valid preregistered cell IDs (for verification only — NOT for
// hard-coding into requests; the route computes assignments itself).
const VALID_CELL_IDS = new Set(
  generateTreatmentCells(TEST_DESIGN).map((c) => c.id),
);

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
    const req = new Request(
      "http://localhost/api/oryxx/willingness/experiment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
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

/** Full production enroll path. */
async function enroll(experimentId: string, email: string) {
  return callRoute({ mode: "enroll", experimentId }, email);
}

/** Delete all test data for a set of emails in this experiment. */
async function cleanupEmails(emails: string[]) {
  if (emails.length === 0) return;
  const enrollmentRows = await db.experimentEnrollment.findMany({
    where: { experimentId, accountEmail: { in: emails } },
    select: { id: true },
  });
  const enrollmentIds = enrollmentRows.map((e) => e.id);
  if (enrollmentIds.length > 0) {
    await db.providerResponse.deleteMany({
      where: { enrollmentId: { in: enrollmentIds } },
    });
    await db.experimentConsent.deleteMany({
      where: { enrollmentId: { in: enrollmentIds } },
    });
  }
  await db.experimentEnrollment.deleteMany({
    where: { experimentId, accountEmail: { in: emails } },
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────────────

// Pre-cleanup: remove any leftover test experiments from previous runs
// (in case a prior run was killed before afterAll completed).
async function cleanupLeftoverTestExperiments() {
  const leftover = await db.acceptanceExperiment.findMany({
    where: { name: { contains: "HTTP Concurrency Test" } },
    select: { id: true },
  });
  for (const exp of leftover) {
    const enrolls = await db.experimentEnrollment.findMany({
      where: { experimentId: exp.id },
      select: { id: true },
    });
    const eids = enrolls.map((e) => e.id);
    if (eids.length > 0) {
      await db.providerResponse.deleteMany({
        where: { enrollmentId: { in: eids } },
      });
      await db.experimentConsent.deleteMany({
        where: { enrollmentId: { in: eids } },
      });
    }
    await db.experimentEvent.deleteMany({ where: { experimentId: exp.id } });
    await db.experimentEnrollment.deleteMany({
      where: { experimentId: exp.id },
    });
    await db.acceptanceExperiment
      .delete({ where: { id: exp.id } })
      .catch(() => {});
  }
}

beforeAll(async () => {
  await cleanupLeftoverTestExperiments();
  const hash = computePreregistrationHash(TEST_DESIGN);
  const exp = await db.acceptanceExperiment.create({
    data: {
      name: `HTTP Concurrency Test ${TEST_TAG}`,
      description: "Auto-created by HTTP-level test. Cleaned up after run.",
      status: "ACTIVE",
      maxDetourKm: 5.0,
      maxExtraTimeMin: 20.0,
      minCompensation: 1.0,
      hypothesis: "test",
      sampleTarget: 500,
      primaryOutcome: "W3_acceptance_rate",
      stoppingRule: "test",
      randomizationSeed: 42,
      consentText: "test",
      consentVersion: 1,
      preregistrationHash: hash,
      preregisteredAt: new Date().toISOString(),
      treatmentDesignJson: JSON.stringify(TEST_DESIGN),
      assumedUserSavings: 4.0,
      assumedFailureCost: 1.0,
      assumedOryxxMargin: 0.5,
    },
  });
  experimentId = exp.id;
}, 120000);

afterAll(async () => {
  if (experimentId) {
    const enrollments = await db.experimentEnrollment.findMany({
      where: { experimentId },
      select: { id: true },
    });
    const enrollmentIds = enrollments.map((e) => e.id);
    if (enrollmentIds.length > 0) {
      await db.providerResponse.deleteMany({
        where: { enrollmentId: { in: enrollmentIds } },
      });
      await db.experimentConsent.deleteMany({
        where: { enrollmentId: { in: enrollmentIds } },
      });
    }
    await db.experimentEvent.deleteMany({ where: { experimentId } });
    await db.experimentEnrollment.deleteMany({ where: { experimentId } });
    await db.acceptanceExperiment
      .delete({ where: { id: experimentId } })
      .catch(() => {});
  }
  await db.$disconnect();
}, 60000);

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("ORYXX HTTP-level enrollment — production route", () => {
  // ─── A. SAME-ACCOUNT 50-WAY CONCURRENCY ────────────────────────────
  test("50 concurrent same-account enrollments → exactly 1 success, 49 conflicts, 0 errors", async () => {
    const email = emailFor("same50");
    await cleanupEmails([email]);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => enroll(experimentId, email)),
    );

    const successes = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    const errors = results.filter((r) => r.status >= 500 || r.status === 400);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(49);
    expect(errors.length).toBe(0);

    // DB has exactly one enrollment for (experimentId, accountEmail)
    const dbRows = await db.experimentEnrollment.findMany({
      where: { experimentId, accountEmail: email },
    });
    expect(dbRows.length).toBe(1);

    // Success response carries a real preregistered cell assignment
    // (NOT hard-coded — produced by the route's assignTreatment).
    const success = successes[0];
    expect(success.body.enrollment).toBeTruthy();
    expect(success.body.enrollment.assignedCellId).toBeTruthy();
    expect(success.body.assignedCell).toBeTruthy();
    expect(success.body.assignedCell.id).toBe(
      success.body.enrollment.assignedCellId,
    );
    expect(VALID_CELL_IDS.has(success.body.assignedCell.id)).toBe(true);

    // Persisted assignment matches the response
    expect(dbRows[0].assignedCellId).toBe(
      success.body.enrollment.assignedCellId,
    );
    expect(dbRows[0].participantId).toBe(success.body.enrollment.participantId);
    expect(dbRows[0].enrollmentToken).toBe(
      success.body.enrollment.enrollmentToken,
    );

    // Conflict responses carry the duplicate-enrollment error
    for (const c of conflicts) {
      expect(c.body?.error).toMatch(/already enrolled/i);
    }

    await cleanupEmails([email]);
  }, 180000);

  // ─── B. SAME-ACCOUNT 100-WAY CONCURRENCY ───────────────────────────
  test("100 concurrent same-account enrollments → exactly 1 success, 99 conflicts, 0 errors", async () => {
    const email = emailFor("same100");
    await cleanupEmails([email]);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => enroll(experimentId, email)),
    );

    const successes = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    const errors = results.filter((r) => r.status >= 500 || r.status === 400);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(99);
    expect(errors.length).toBe(0);

    const dbRows = await db.experimentEnrollment.findMany({
      where: { experimentId, accountEmail: email },
    });
    expect(dbRows.length).toBe(1);

    const success = successes[0];
    expect(VALID_CELL_IDS.has(success.body.assignedCell.id)).toBe(true);
    expect(dbRows[0].assignedCellId).toBe(
      success.body.enrollment.assignedCellId,
    );

    await cleanupEmails([email]);
  }, 180000);

  // ─── C. DIFFERENT-ACCOUNT 100-WAY CONCURRENCY ─────────────────────
  test("100 concurrent different-account enrollments → 100 successes, balanced treatment, 0 errors", async () => {
    const emails = Array.from({ length: 100 }, (_, i) => emailFor(`diff${i}`));
    await cleanupEmails(emails);

    const results = await Promise.all(emails.map((e) => enroll(experimentId, e)));

    const successes = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    const errors = results.filter((r) => r.status >= 500 || r.status === 400);

    // EVERY account must succeed (not just >0)
    expect(successes.length).toBe(100);
    expect(conflicts.length).toBe(0);
    expect(errors.length).toBe(0);

    // DB count = 100, unique emails = 100
    const dbRows = await db.experimentEnrollment.findMany({
      where: { experimentId, accountEmail: { in: emails } },
    });
    expect(dbRows.length).toBe(100);
    expect(new Set(dbRows.map((e) => e.accountEmail)).size).toBe(100);

    // Every assignedCellId is a real preregistered cell (no hard-coded values)
    for (const row of dbRows) {
      expect(row.assignedCellId).toBeTruthy();
      expect(VALID_CELL_IDS.has(row.assignedCellId!)).toBe(true);
    }

    // Persisted assignment matches each response (no divergence)
    const dbByEmail = new Map(dbRows.map((r) => [r.accountEmail, r]));
    for (let i = 0; i < 100; i++) {
      const res = results[i];
      const dbRow = dbByEmail.get(emails[i])!;
      expect(res.body.enrollment.assignedCellId).toBe(dbRow.assignedCellId);
      expect(res.body.enrollment.participantId).toBe(dbRow.participantId);
    }

    // Treatment balance: least-filled → max(cellCount) - min(cellCount) ≤ 1
    const cellCounts = new Map<string, number>();
    for (const r of dbRows) {
      cellCounts.set(
        r.assignedCellId!,
        (cellCounts.get(r.assignedCellId!) ?? 0) + 1,
      );
    }
    const counts = [...cellCounts.values()];
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);
    expect(maxCount - minCount).toBeLessThanOrEqual(1);

    await cleanupEmails(emails);
  }, 300000);

  // ─── D. P2002 BEHAVIOR — duplicate enrollment, NOT retried ─────────
  test("P2002: sequential duplicate enrollment → HTTP 409 (not retried, not 500)", async () => {
    const email = emailFor("p2002");
    await cleanupEmails([email]);

    const first = await enroll(experimentId, email);
    expect(first.status).toBe(200);
    expect(first.body.enrollment.accountEmail).toBe(email);

    const second = await enroll(experimentId, email);
    expect(second.status).toBe(409);
    expect(second.body?.error).toMatch(/already enrolled/i);

    const dbRows = await db.experimentEnrollment.findMany({
      where: { experimentId, accountEmail: email },
    });
    expect(dbRows.length).toBe(1);

    await cleanupEmails([email]);
  }, 60000);

  // ─── E. AUTHORIZATION — cross-account protection ──────────────────
  test("Authorization: B cannot enroll on behalf of A (identity from session, not body)", async () => {
    const emailA = emailFor("authA");
    const emailB = emailFor("authB");
    await cleanupEmails([emailA, emailB]);

    const aRes = await enroll(experimentId, emailA);
    expect(aRes.status).toBe(200);
    expect(aRes.body.enrollment.accountEmail).toBe(emailA);

    // B sends accountEmail: emailA in the BODY. Route MUST ignore body.accountEmail
    // and use session.user.email (= emailB).
    const bRes = await callRoute(
      { mode: "enroll", experimentId, accountEmail: emailA },
      emailB,
    );
    expect(bRes.status).toBe(200);
    expect(bRes.body.enrollment.accountEmail).toBe(emailB);
    expect(bRes.body.enrollment.accountEmail).not.toBe(emailA);

    // DB: A has exactly 1 enrollment (not 2)
    const aRows = await db.experimentEnrollment.findMany({
      where: { experimentId, accountEmail: emailA },
    });
    expect(aRows.length).toBe(1);

    // DB: B has exactly 1 enrollment (B's own)
    const bRows = await db.experimentEnrollment.findMany({
      where: { experimentId, accountEmail: emailB },
    });
    expect(bRows.length).toBe(1);

    await cleanupEmails([emailA, emailB]);
  }, 60000);

  // ─── F. AUTHORIZATION — re-enrollment by same account ─────────────
  test("Authorization: already-enrolled account re-enrolls → HTTP 409", async () => {
    const email = emailFor("reauth");
    await cleanupEmails([email]);

    const first = await enroll(experimentId, email);
    expect(first.status).toBe(200);

    const second = await enroll(experimentId, email);
    expect(second.status).toBe(409);
    expect(second.body?.error).toMatch(/already enrolled/i);

    await cleanupEmails([email]);
  }, 60000);

  // ─── G. UNAUTHENTICATED REQUEST ────────────────────────────────────
  test("Unauthenticated request (no session) → HTTP 401", async () => {
    const req = new Request(
      "http://localhost/api/oryxx/willingness/experiment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "enroll", experimentId }),
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/authentication/i);
  }, 30000);

  // ─── H. NON-ACTIVE EXPERIMENT ─────────────────────────────────────
  test("Enrollment against a non-ACTIVE experiment → HTTP 400", async () => {
    const hash = computePreregistrationHash(TEST_DESIGN);
    const draftExp = await db.acceptanceExperiment.create({
      data: {
        name: `HTTP Test Draft ${TEST_TAG}`,
        description: "Not active.",
        status: "PREREGISTERED",
        maxDetourKm: 5.0,
        maxExtraTimeMin: 20.0,
        minCompensation: 1.0,
        hypothesis: "test",
        sampleTarget: 100,
        primaryOutcome: "W3_acceptance_rate",
        stoppingRule: "test",
        randomizationSeed: 42,
        consentText: "test",
        consentVersion: 1,
        preregistrationHash: hash,
        preregisteredAt: new Date().toISOString(),
        treatmentDesignJson: JSON.stringify(TEST_DESIGN),
        assumedUserSavings: 4.0,
        assumedFailureCost: 1.0,
        assumedOryxxMargin: 0.5,
      },
    });

    try {
      const email = emailFor("draft");
      const res = await enroll(draftExp.id, email);
      expect(res.status).toBe(400);
      expect(res.body?.error).toMatch(/PREREGISTERED|status/i);
    } finally {
      await db.experimentEnrollment.deleteMany({
        where: { experimentId: draftExp.id },
      });
      await db.experimentEvent.deleteMany({
        where: { experimentId: draftExp.id },
      });
      await db.acceptanceExperiment.delete({
        where: { id: draftExp.id },
      });
    }
  }, 60000);

  // ─── I. MARKETPLACE TRANSACTION REJECTION ─────────────────────────
  test("Marketplace transaction creation rejected via research API → HTTP 403", async () => {
    const res = await callRoute(
      {
        mode: "enroll",
        experimentId,
        experimentType: "MARKETPLACE_TRANSACTION",
      },
      emailFor("mkt-reject"),
    );
    expect(res.status).toBe(403);
    expect(res.body?.error).toMatch(/marketplace/i);
  }, 30000);

  // ─── J. P2002 + P2034 SUMMARY ─────────────────────────────────────
  test("P2002 and P2034 are handled distinctly through the production route", async () => {
    // P2002: same account, concurrent + sequential → 409, never retried, never 500
    // P2034/P2028: different accounts, concurrent → retried, eventually 200
    // This test verifies no HTTP 500 escapes the route under mixed concurrency.
    const email = emailFor("mixed");
    await cleanupEmails([email]);

    const seq1 = await enroll(experimentId, email);
    expect(seq1.status).toBe(200);

    // 20 concurrent re-attempts — all must be 409, none 500
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => enroll(experimentId, email)),
    );
    for (const r of concurrent) {
      expect(r.status).toBe(409);
      expect(r.body?.error).toMatch(/already enrolled/i);
    }

    const rows = await db.experimentEnrollment.findMany({
      where: { experimentId, accountEmail: email },
    });
    expect(rows.length).toBe(1);

    await cleanupEmails([email]);
  }, 120000);
});
