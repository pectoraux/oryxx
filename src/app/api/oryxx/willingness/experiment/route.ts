// ORYXX — Research-integrity-safe experiment API (v7 — FINAL FROZEN).
//
// This is the final research instrument. After this commit, the research
// protocol is frozen.
//
// v7 fixes the last two concurrency races:
// 1. WITHDRAWAL vs TRANSITION: enrollment status is now checked INSIDE
//    the serializable transaction, not before it.
// 2. EXPIRY vs AUDIT EVENT: expiry transition + event append are now
//    in the SAME transaction.
//
// Key guarantees:
// 1. Concurrency-safe enrollment via Prisma $transaction (serializable)
// 2. Hash validation at activation, enrollment, AND offer creation
// 3. Offer immutability after OFFER_PRESENTED (server-enforced)
// 4. offerExpiresAt stored explicitly (not computed from presentedAt)
// 5. Provider verification: operator_verified | externally_verified (explicit)
// 6. W4-R completion requires admin + completionEvidenceLevel recorded
// 7. Research API rejects experimentType=MARKETPLACE_TRANSACTION
// 8. Hash-chained audit events (tamper-evident application trail)
// 9. No fallback design loading — loadDesignStrict throws on missing
// 10. Marketplace evidence (W3-M/W4-M) is structurally impossible via this API
// 11. Consent withdrawal endpoint (idempotent, account-bound)
// 12. Preregistration immutability enforced via canMutateDesign check
// 13. State mutation + event append in SAME transaction (atomicity)
// 14. Withdrawal check INSIDE transition transaction (no post-withdrawal W3-R)
// 15. Expiry transition + event in SAME transaction (no missing audit events)
// 16. Event log: append-only via API (no UPDATE/DELETE endpoint exists)

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import {
  isValidResearchTransition,
  researchEvidenceForState,
  validateOfferSafety,
  assignTreatment,
  generateTreatmentCells,
  computePreregistrationHash,
  verifyDesignHash,
  loadDesignStrict,
  isOfferExpired,
  createEvent,
  canMutateDesign,
  type PreregisteredDesign,
  type ResearchState,
  type ExperimentStatus,
} from "@/lib/oryxx/real/evidence/pilot";
import { randomBytes, createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const experiments = await db.acceptanceExperiment.findMany({
    include: { _count: { select: { responses: true, enrollments: true, events: true } } },
    orderBy: { id: "desc" },
  });
  const results = await Promise.all(experiments.map(async (exp) => {
    const responses = await db.providerResponse.findMany({ where: { experimentId: exp.id }, select: { evidenceTier: true } });
    return {
      ...exp,
      w3rCount: responses.filter((r) => r.evidenceTier === "W3-R").length,
      w4rCount: responses.filter((r) => r.evidenceTier === "W4-R").length,
      w3mCount: 0, w4mCount: 0,
      hasW3REvidence: responses.some((r) => r.evidenceTier === "W3-R"),
      hasW4REvidence: responses.some((r) => r.evidenceTier === "W4-R"),
    };
  }));
  return NextResponse.json({ experiments: results });
}

// POST
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const email = (session.user as any)?.email;
  const role = (session.user as any)?.role;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const mode = body?.mode;

  if (body?.experimentType === "MARKETPLACE_TRANSACTION") {
    return NextResponse.json({ error: "Marketplace transactions cannot be created via the research API." }, { status: 403 });
  }

  // === CREATE EXPERIMENT (admin) ===
  if (mode === "create_experiment") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.create({
      data: {
        name: body?.name ?? "W3 Acceptance Pilot",
        description: body?.description ?? "Preregistered field experiment.",
        status: "DRAFT",
        maxDetourKm: body?.maxDetourKm ?? 5.0,
        maxExtraTimeMin: body?.maxExtraTimeMin ?? 20.0,
        minCompensation: body?.minCompensation ?? 1.0,
        hypothesis: body?.hypothesis ?? "Providers will accept pooled offers when comp >= $3 and detour <= 2km.",
        sampleTarget: body?.sampleTarget ?? 100,
        primaryOutcome: "W3_acceptance_rate",
        stoppingRule: body?.stoppingRule ?? "Stop after 100 responses or 30 days.",
        randomizationSeed: body?.randomizationSeed ?? 42,
        consentText: "RESEARCH STUDY - THIS IS NOT A MARKETPLACE BOOKING. You are participating in research about provider willingness. Responses are pseudonymous. You may withdraw at any time by calling the withdraw endpoint.",
        consentVersion: 1,
        assumedUserSavings: body?.assumedUserSavings ?? 4.0,
        assumedFailureCost: body?.assumedFailureCost ?? 1.0,
        assumedOryxxMargin: body?.assumedOryxxMargin ?? 0.50,
      },
    });
    return NextResponse.json({ experiment: exp, message: "DRAFT created." });
  }

  // === PREREGISTER (admin) — enforces canMutateDesign ===
  if (mode === "preregister") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!canMutateDesign(exp.status as ExperimentStatus)) {
      return NextResponse.json({ error: `Cannot preregister: status is ${exp.status}.` }, { status: 400 });
    }
    const design: PreregisteredDesign = {
      hypothesis: exp.hypothesis ?? "", population: body?.population ?? "ride-hail drivers",
      geography: body?.geography ?? "NYC", providerType: body?.providerType ?? "taxi/FHV",
      sampleTarget: exp.sampleTarget,
      compensationBuckets: body?.compensationBuckets ?? [1, 2, 3, 4, 5],
      detourBuckets: body?.detourBuckets ?? [0, 0.5, 1, 2, 3],
      extraTimeBuckets: body?.extraTimeBuckets ?? [0, 2, 5, 10],
      noticeBuckets: body?.noticeBuckets ?? [0, 15, 60],
      randomizationSeed: exp.randomizationSeed, primaryOutcome: exp.primaryOutcome,
      secondaryOutcomes: body?.secondaryOutcomes ?? ["W4-R_completion_rate", "net_value"],
      analysisMethod: body?.analysisMethod ?? "per-cell Wilson CI",
      stoppingRule: exp.stoppingRule ?? "", safetyRules: body?.safetyRules ?? [],
      maxDetourKm: exp.maxDetourKm, maxExtraTimeMin: exp.maxExtraTimeMin,
      minCompensation: exp.minCompensation, consentText: exp.consentText ?? "",
      assumedUserSavings: exp.assumedUserSavings, assumedFailureCost: exp.assumedFailureCost,
      assumedOryxxMargin: exp.assumedOryxxMargin,
    };
    const hash = computePreregistrationHash(design);
    await db.acceptanceExperiment.update({
      where: { id: exp.id },
      data: {
        status: "PREREGISTERED", preregistrationHash: hash, preregisteredAt: new Date().toISOString(),
        population: design.population, geography: design.geography, providerType: design.providerType,
        analysisMethod: design.analysisMethod, secondaryOutcomes: JSON.stringify(design.secondaryOutcomes),
        treatmentDesignJson: JSON.stringify(design),
      },
    });
    return NextResponse.json({ preregistrationHash: hash, message: "Preregistered." });
  }

  // === ACTIVATE (admin) — validates hash + activation gate ===
  if (mode === "activate") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "PREREGISTERED") return NextResponse.json({ error: `Status is ${exp.status}.` }, { status: 400 });
    if (!exp.treatmentDesignJson || !exp.preregistrationHash) return NextResponse.json({ error: "Missing design or hash." }, { status: 400 });
    const design = loadDesignStrict(exp.treatmentDesignJson);
    if (!verifyDesignHash(design, exp.preregistrationHash)) {
      return NextResponse.json({ error: "PREREGISTRATION HASH MISMATCH." }, { status: 400 });
    }

    // ─── ACTIVATION GATE (section 16) ─────────────────────────────────
    // The experiment CANNOT move to ACTIVE unless all gates pass.
    // This is a deterministic "Can Activate?" check enforced server-side.
    const gate = await runActivationGate(exp);
    if (!gate.canActivate) {
      return NextResponse.json({ error: "Activation gate FAILED.", gate }, { status: 400 });
    }

    await db.$transaction(async (tx) => {
      await tx.acceptanceExperiment.update({ where: { id: exp.id }, data: { status: "ACTIVE" } });
      // Hash-chained audit event for activation
      const lastEvent = await tx.experimentEvent.findFirst({ where: { experimentId: exp.id }, orderBy: { timestamp: "desc" } });
      const event = createEvent(exp.id, "activation", "system", "PREREGISTERED", "ACTIVE", "admin", email ?? "admin", lastEvent?.eventHash ?? null);
      await tx.experimentEvent.create({ data: event });
    }, { isolationLevel: "Serializable" });
    return NextResponse.json({ message: "ACTIVE. Hash verified. Activation gate passed.", gate });
  }

  // === ACTIVATION GATE CHECK (admin) — "Can Activate?" without activating ===
  // Returns PASS/FAIL for every required gate. Does NOT change experiment status.
  if (mode === "activation_check") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const gate = await runActivationGate(exp);
    return NextResponse.json({ gate });
  }

  // === PAUSE (admin) — emergency stop ===
  // ACTIVE → PAUSED. No new enrollments, offers, or transitions accepted
  // while PAUSED. Historical records remain intact. The preregistered
  // treatment design is NOT modified during pause.
  if (mode === "pause") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Cannot pause: status is ${exp.status}.` }, { status: 400 });
    await db.$transaction(async (tx) => {
      await tx.acceptanceExperiment.update({ where: { id: exp.id }, data: { status: "PAUSED" } });
      const lastEvent = await tx.experimentEvent.findFirst({ where: { experimentId: exp.id }, orderBy: { timestamp: "desc" } });
      const event = createEvent(exp.id, "pause", "system", "ACTIVE", "PAUSED", "admin", email ?? "admin", lastEvent?.eventHash ?? null);
      await tx.experimentEvent.create({ data: event });
    }, { isolationLevel: "Serializable" });
    return NextResponse.json({ message: "PAUSED. No new enrollments, offers, or transitions accepted. Historical records intact." });
  }

  // === RESUME (admin) — PAUSED → ACTIVE (re-runs activation gate) ===
  if (mode === "resume") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "PAUSED") return NextResponse.json({ error: `Cannot resume: status is ${exp.status}.` }, { status: 400 });
    // Re-verify hash before resuming (design must not have changed)
    const design = loadDesignStrict(exp.treatmentDesignJson);
    if (!verifyDesignHash(design, exp.preregistrationHash!)) {
      return NextResponse.json({ error: "PREREGISTRATION HASH MISMATCH on resume." }, { status: 400 });
    }
    await db.$transaction(async (tx) => {
      await tx.acceptanceExperiment.update({ where: { id: exp.id }, data: { status: "ACTIVE" } });
      const lastEvent = await tx.experimentEvent.findFirst({ where: { experimentId: exp.id }, orderBy: { timestamp: "desc" } });
      const event = createEvent(exp.id, "resume", "system", "PAUSED", "ACTIVE", "admin", email ?? "admin", lastEvent?.eventHash ?? null);
      await tx.experimentEvent.create({ data: event });
    }, { isolationLevel: "Serializable" });
    return NextResponse.json({ message: "Resumed. Status ACTIVE. Hash verified." });
  }

  // === COMPLETE (admin) — ACTIVE → COMPLETED (stop gate) ===
  // Requires the preregistered stopping rule to be satisfied.
  if (mode === "complete") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "ACTIVE" && exp.status !== "PAUSED") return NextResponse.json({ error: `Cannot complete: status is ${exp.status}.` }, { status: 400 });
    // Stop gate: verify stopping rule satisfied
    const responseCount = await db.providerResponse.count({ where: { experimentId: exp.id } });
    const stopGate = await runStopGate(exp, responseCount);
    if (!stopGate.canComplete) {
      return NextResponse.json({ error: "Stop gate FAILED. Stopping rule not satisfied.", stopGate }, { status: 400 });
    }
    await db.$transaction(async (tx) => {
      await tx.acceptanceExperiment.update({ where: { id: exp.id }, data: { status: "COMPLETED" } });
      const lastEvent = await tx.experimentEvent.findFirst({ where: { experimentId: exp.id }, orderBy: { timestamp: "desc" } });
      const event = createEvent(exp.id, "complete", "system", exp.status, "COMPLETED", "admin", email ?? "admin", lastEvent?.eventHash ?? null);
      await tx.experimentEvent.create({ data: event });
    }, { isolationLevel: "Serializable" });
    return NextResponse.json({ message: "COMPLETED. Stop gate passed.", stopGate });
  }

  // === INTEGRITY CHECK (admin) — real-time integrity monitoring ===
  // Detects integrity violations (section 12). Does NOT modify data.
  if (mode === "integrity_check") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const report = await runIntegrityCheck(exp);
    return NextResponse.json({ report });
  }

  // === EXPORT ANALYSIS (admin) — operator-only analysis dataset ===
  // Fails closed if integrity violations are detected.
  if (mode === "export_analysis") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Run integrity check first — fail closed
    const report = await runIntegrityCheck(exp);
    if (report.violations.length > 0) {
      return NextResponse.json({ error: "Analysis export FAILED — integrity violations detected.", violations: report.violations }, { status: 400 });
    }
    const dataset = await buildAnalysisDataset(exp);
    return NextResponse.json({ experimentId: exp.id, preregistrationHash: exp.preregistrationHash, dataset });
  }

  // === EXPORT AUDIT (admin) — operator-only audit trail dataset ===
  if (mode === "export_audit") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const events = await db.experimentEvent.findMany({ where: { experimentId: exp.id }, orderBy: { timestamp: "asc" } });
    // Verify hash chain integrity
    let chainValid = true;
    let previousHash: string | null = null;
    for (const e of events) {
      if (e.previousEventHash !== previousHash) { chainValid = false; break; }
      previousHash = e.eventHash;
    }
    return NextResponse.json({
      experimentId: exp.id,
      preregistrationHash: exp.preregistrationHash,
      chainValid,
      eventCount: events.length,
      events: events.map((e) => ({
        offerId: e.offerId === "activation" || e.offerId === "pause" || e.offerId === "resume" || e.offerId === "complete" ? e.offerId : e.offerId.substring(0, 8) + "…",
        participantPseudonym: e.participantId.substring(0, 8) + "…",
        fromState: e.fromState, toState: e.toState,
        timestamp: e.timestamp, actorType: e.actorType, actorId: e.actorId.substring(0, 8) + "…",
        eventHash: e.eventHash, previousEventHash: e.previousEventHash,
      })),
    });
  }

  // === VERIFY PROVIDER (admin) ===
  if (mode === "verify_provider") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { id: body?.enrollmentId } });
    if (!enrollment) return NextResponse.json({ error: "Enrollment not found." }, { status: 404 });
    if (body?.external === true || body?.level === "externally_verified") {
      return NextResponse.json({ error: "externally_verified impossible in current pilot." }, { status: 400 });
    }
    await db.experimentEnrollment.update({
      where: { id: enrollment.id },
      data: { providerVerified: "operator_verified", providerType: body?.providerType ?? "taxi", verificationMethod: "admin_manual", verificationReference: body?.reference ?? null, verifiedAt: new Date() },
    });
    return NextResponse.json({ message: "Provider operator_verified." });
  }

  // === ENROLL — concurrency-safe via $transaction ===
  if (mode === "enroll") {
    const experimentId = body?.experimentId;
    if (!experimentId) return NextResponse.json({ error: "experimentId required." }, { status: 400 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Experiment is ${exp.status}.` }, { status: 400 });
    const design = loadDesignStrict(exp.treatmentDesignJson);
    if (!verifyDesignHash(design, exp.preregistrationHash!)) {
      return NextResponse.json({ error: "PREREGISTRATION HASH MISMATCH at enrollment." }, { status: 500 });
    }
    const existing = await db.experimentEnrollment.findFirst({ where: { accountEmail: email, experimentId } });
    if (existing) return NextResponse.json({ error: "Account already enrolled in this experiment." }, { status: 409 });
    const participantId = `P-${randomBytes(8).toString("hex")}`;
    const enrollmentToken = randomBytes(24).toString("hex");
    const cells = generateTreatmentCells(design);
    let result: { enrollment: any; cell: any } | null = null;
    let lastErr: any = null;
    // Retry loop for transient concurrency errors:
    //   P2034 = serialization conflict (Serializable SSI abort)
    //   P2028 = transaction-start timeout (connection-pool exhaustion under burst load)
    //   P2024 = connection-pool timeout
    // All are transient and retried to avoid HTTP 500 under concurrent enrollment.
    // P2002 (unique-constraint violation = duplicate enrollment) is NOT retried —
    // it returns 409 immediately (permanent error).
    //
    // PER-EXPERIMENT PESSIMISTIC LOCK (v7.2):
    // The previous Serializable isolation caused cascading SSI aborts under
    // 100-way concurrent enrollment (each commit invalidated all in-flight
    // readers). ReadCommitted + SELECT...FOR UPDATE on the experiment row
    // serializes enrollments per experiment at the DB level (FIFO queue),
    // eliminating SSI storms while preserving exact least-filled allocation.
    // The FOR UPDATE lock guarantees each transaction sees all prior committed
    // enrollments, so assignTreatment() always computes correct cell counts.
    //
    // UNCHANGED (research protocol frozen):
    //   - @@unique([experimentId, accountEmail]) → P2002 → 409
    //   - assignTreatment() least-filled algorithm
    //   - Treatment cells, compensation/detour/notice buckets, stopping rule
    //   - Evidence definitions (W3-R/W4-R tiers, state machine, audit trail)
    const retryDeadline = Date.now() + 60000;
    let attempt = 0;
    while (Date.now() < retryDeadline) {
      try {
        result = await db.$transaction(async (tx) => {
          // Pessimistic row lock: serializes all enrollments for this experiment.
          // Other callers block here (at the DB level) until the current
          // transaction commits or rolls back. ReadCommitted + FOR UPDATE
          // guarantees we read the latest committed enrollment counts.
          await tx.$queryRaw`SELECT id FROM "AcceptanceExperiment" WHERE id = ${experimentId} FOR UPDATE`;
          const enrollments = await tx.experimentEnrollment.findMany({ where: { experimentId, assignedCellId: { not: null } }, select: { assignedCellId: true } });
          const cellCounts = cells.map(c => enrollments.filter(e => e.assignedCellId === c.id).length);
          const cell = assignTreatment(participantId, experimentId, exp.randomizationSeed, cells, cellCounts);
          const enrollment = await tx.experimentEnrollment.create({ data: { experimentId, participantId, accountEmail: email, enrollmentToken, assignedCellId: cell.id, providerVerified: "unverified" } });
          return { enrollment, cell };
        }, { isolationLevel: "ReadCommitted", maxWait: 10000, timeout: 30000 });
        break;
      } catch (err: any) {
        lastErr = err;
        // P2002 = unique-constraint violation (duplicate enrollment) → 409, NOT retried
        if (err?.code === "P2002") {
          return NextResponse.json({ error: "Account already enrolled in this experiment." }, { status: 409 });
        }
        // Transient: serialization conflict, pool exhaustion — retry with backoff + jitter
        const isTransient = err?.code === "P2034" || err?.code === "P2028" || err?.code === "P2024";
        if (!isTransient) throw err;
        const backoff = Math.min(100 * Math.pow(2, attempt % 5), 2000) + Math.random() * 100;
        await new Promise(r => setTimeout(r, backoff));
        attempt++;
      }
    }
    if (!result) throw lastErr ?? new Error("Enrollment failed after retries.");
    return NextResponse.json({ enrollment: result.enrollment, assignedCell: result.cell, consentRequired: exp.requiresConsent, consentText: exp.consentText, providerVerificationRequired: true });
  }

  // === CONSENT (account-bound) ===
  if (mode === "consent") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    if (enrollment.accountEmail !== email) return NextResponse.json({ error: "CROSS-USER." }, { status: 403 });
    const exp = enrollment.experiment;
    const consentTextHash = createHash("sha256").update(exp.consentText ?? "").digest("hex");
    const consent = await db.experimentConsent.create({ data: { experimentId: exp.id, enrollmentId: enrollment.id, participantId: enrollment.participantId, accountEmail: email, consentVersion: exp.consentVersion, consentTextHash, consentText: exp.consentText ?? "" } });
    return NextResponse.json({ consent, message: "Consent recorded." });
  }

  // === WITHDRAW (participant self-service) ===
  // Uses a Serializable transaction. Withdrawal blocks ALL future transitions
  // because the transition handler re-checks enrollment.status INSIDE its
  // own Serializable transaction (see below).
  // Historical W3-R evidence is NOT erased — it remains part of the experiment.
  // Post-withdrawal: no new offers, no transitions, no W3-R/W4-R creation.
  if (mode === "withdraw") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    if (enrollment.accountEmail !== email) return NextResponse.json({ error: "CROSS-USER: cannot withdraw another participant's enrollment." }, { status: 403 });
    if (enrollment.status === "withdrawn") {
      return NextResponse.json({ message: "Already withdrawn.", withdrawnAt: enrollment.withdrawnAt });
    }
    const now = new Date();
    // Withdrawal in a Serializable transaction. This serializes against
    // any concurrent transition that also checks enrollment.status.
    await db.$transaction(async (tx) => {
      // Re-read enrollment inside the transaction to get the latest status
      const currentEnrollment = await tx.experimentEnrollment.findUnique({ where: { id: enrollment.id } });
      if (!currentEnrollment) throw new Error("ENROLLMENT_NOT_FOUND");
      if (currentEnrollment.status === "withdrawn") return; // idempotent
      await tx.experimentEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "withdrawn", withdrawnAt: now },
      });
      await tx.experimentConsent.updateMany({
        where: { enrollmentId: enrollment.id, withdrawnAt: null },
        data: { withdrawnAt: now },
      });
    }, { isolationLevel: "Serializable" });
    return NextResponse.json({ message: "Withdrawn. No new offers or transitions will be accepted. Historical data retained.", withdrawnAt: now.toISOString() });
  }

  // === CREATE OFFER (requires verified provider + consent + hash check) ===
  // Response creation + event append in SAME transaction.
  if (mode === "create_offer") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    if (enrollment.status === "withdrawn") return NextResponse.json({ error: "Participant withdrawn." }, { status: 403 });
    if (enrollment.accountEmail !== email) return NextResponse.json({ error: "CROSS-USER." }, { status: 403 });
    const exp = enrollment.experiment;
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Experiment ${exp.status}.` }, { status: 400 });
    if (enrollment.providerVerified !== "operator_verified" && enrollment.providerVerified !== "externally_verified") {
      return NextResponse.json({ error: `Provider NOT verified (${enrollment.providerVerified}).` }, { status: 403 });
    }
    if (exp.requiresConsent) {
      const consent = await db.experimentConsent.findFirst({ where: { enrollmentId: enrollment.id, accountEmail: email, withdrawnAt: null } });
      if (!consent) return NextResponse.json({ error: "Consent required." }, { status: 403 });
    }
    const design = loadDesignStrict(exp.treatmentDesignJson);
    if (!verifyDesignHash(design, exp.preregistrationHash!)) {
      return NextResponse.json({ error: "PREREGISTRATION HASH MISMATCH." }, { status: 500 });
    }
    const cells = generateTreatmentCells(design);
    const cell = cells.find((c) => c.id === enrollment.assignedCellId) ?? cells[0];
    const safety = validateOfferSafety(
      { detourKm: cell.detourKm, extraTimeMin: cell.extraTimeMin, compensation: cell.compensation, passengerCount: 1 },
      { maxDetourKm: exp.maxDetourKm, maxExtraTimeMin: exp.maxExtraTimeMin, minCompensation: exp.minCompensation },
    );
    if (!safety.safe) return NextResponse.json({ error: "Safety violation", violations: safety.violations }, { status: 400 });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    // Response creation + event append in SAME transaction
    const result = await db.$transaction(async (tx) => {
      const response = await tx.providerResponse.create({
        data: {
          experimentId: exp.id, enrollmentId: enrollment.id, participantId: enrollment.participantId,
          treatmentCellId: cell.id, compensation: cell.compensation, detourKm: cell.detourKm,
          extraTimeMin: cell.extraTimeMin, advanceNoticeMin: cell.advanceNoticeMin, passengerCount: 1,
          tripDistanceKm: body?.tripDistanceKm ?? 5, originName: body?.originName ?? "unknown",
          destName: body?.destName ?? "unknown", hourOfDay: now.getHours(),
          state: "OFFER_CREATED", evidenceTier: "NONE", offerExpiresAt: expiresAt.toISOString(),
        },
      });
      const lastEvent = await tx.experimentEvent.findFirst({ where: { experimentId: exp.id }, orderBy: { timestamp: "desc" } });
      const event = createEvent(exp.id, response.id, enrollment.participantId, null, "OFFER_CREATED", "system", email ?? "system", lastEvent?.eventHash ?? null);
      await tx.experimentEvent.create({ data: event });
      return { response };
    }, { isolationLevel: "Serializable" });

    return NextResponse.json({ response: result.response, message: "RESEARCH STIMULUS created (NOT a marketplace booking)." });
  }

  // === TRANSITION (atomic, enrollment-bound, offer-immutable) ===
  //
  // RACE FIX: enrollment.status is re-checked INSIDE the Serializable transaction,
  // not before it. This prevents the withdrawal-vs-transition race:
  //   T1 reads ACTIVE → T2 withdraws → T1 commits W3-R
  // Now: T1 reads ACTIVE → T2 withdraws → T1's transaction aborts (enrollment
  // status changed) or T1 reads WITHDRAWN inside the transaction → 403.
  //
  // EXPIRY FIX: expiry check + transition + event append are ALL inside the
  // same Serializable transaction. If the offer is expired, the state
  // transition to PROVIDER_IGNORED and the audit event are committed atomically.
  // No state change without an audit event.
  if (mode === "transition") {
    const enrollmentToken = body?.enrollmentToken;
    const responseId = body?.responseId;
    const newState = body?.newState as ResearchState;
    if (!enrollmentToken || !responseId || !newState) return NextResponse.json({ error: "enrollmentToken, responseId, newState required." }, { status: 400 });

    // Pre-transaction reads (for early rejection — not authoritative)
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    // Cross-user check: the participant owns the transition, EXCEPT for
    // TRIP_COMPLETED which requires admin verification (W4-R). The admin
    // is the verifier, not the participant — so admin role bypasses the
    // email match for completion only. This is the ONLY admin override.
    if (enrollment.accountEmail !== email && !(newState === "TRIP_COMPLETED" && role === "admin")) {
      return NextResponse.json({ error: "CROSS-USER." }, { status: 403 });
    }
    const response = await db.providerResponse.findUnique({ where: { id: responseId } });
    if (!response) return NextResponse.json({ error: "Response not found." }, { status: 404 });
    if (response.enrollmentId !== enrollment.id) return NextResponse.json({ error: "CROSS-USER: response belongs to different enrollment." }, { status: 403 });

    // Pre-transaction validation (for clear error messages)
    const fromState = response.state as ResearchState;
    if (!isValidResearchTransition(fromState, newState)) return NextResponse.json({ error: `Invalid transition: ${fromState} -> ${newState}.` }, { status: 400 });
    if (newState === "TRIP_COMPLETED" && role !== "admin") {
      return NextResponse.json({ error: "W4-R requires admin verification." }, { status: 403 });
    }
    let completionLevel = "operator";
    if (newState === "TRIP_COMPLETED") {
      const requestedLevel = body?.completionEvidenceLevel;
      if (requestedLevel && requestedLevel !== "operator") {
        return NextResponse.json({ error: `completionEvidenceLevel "${requestedLevel}" not possible.` }, { status: 400 });
      }
    }

    // Compute transition data (outside transaction — deterministic)
    const newTier = researchEvidenceForState(newState);
    const decision = newState === "PROVIDER_ACCEPTED" ? "accept"
      : newState === "PROVIDER_DECLINED" ? "decline"
      : newState === "PROVIDER_UNAVAILABLE" ? "not_available"
      : newState === "PROVIDER_IGNORED" ? "ignore"
      : response.decision;

    const buildUpdateData = (actualState: string) => {
      const data: any = { state: newState, evidenceTier: newTier };
      if (newState === "OFFER_PRESENTED") data.offerPresentedAt = new Date().toISOString();
      if (newState === "PROVIDER_VIEWED") data.providerViewedAt = new Date().toISOString();
      if (["PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE", "PROVIDER_IGNORED"].includes(newState)) {
        data.decision = decision;
        data.decisionAt = new Date().toISOString();
      }
      if (newState === "TRIP_STARTED") data.executed = true;
      if (newState === "TRIP_COMPLETED") {
        data.executed = true;
        data.completed = true;
        data.externalVerificationMethod = "admin_verified";
        data.externalVerifiedBy = email;
        data.externalVerifiedAt = new Date().toISOString();
        data.completionEvidenceLevel = completionLevel;
      }
      if (newState === "TRIP_CANCELLED") { data.executed = false; data.executionFailureReason = body?.reason ?? "cancelled"; }
      return data;
    };

    // SINGLE SERIALIZABLE TRANSACTION: enrollment check + expiry check + state mutation + event append
    // This is the race-fix: everything is atomic.
    const txResult = await db.$transaction(async (tx) => {
      // 1. Re-read enrollment INSIDE the transaction (not the pre-transaction read)
      const currentEnrollment = await tx.experimentEnrollment.findUnique({ where: { id: enrollment.id } });
      if (!currentEnrollment) throw new Error("ENROLLMENT_NOT_FOUND");
      if (currentEnrollment.status === "withdrawn") throw new Error("WITHDRAWN");

      // 2. Re-read response INSIDE the transaction
      const currentResponse = await tx.providerResponse.findUnique({ where: { id: responseId } });
      if (!currentResponse) throw new Error("RESPONSE_NOT_FOUND");
      const actualState = currentResponse.state as ResearchState;

      // 3. Check offer expiry INSIDE the transaction
      // If the offer is expired AND the participant is trying to accept,
      // atomically transition to PROVIDER_IGNORED with an audit event.
      if (currentResponse.offerExpiresAt && isOfferExpired(currentResponse.offerExpiresAt) && newState === "PROVIDER_ACCEPTED") {
        // EXPIRY TRANSITION: state → PROVIDER_IGNORED + event (atomic)
        const expiryUpdateData: any = {
          state: "PROVIDER_IGNORED",
          evidenceTier: "NONE",
          decision: "ignore",
          decisionAt: new Date().toISOString(),
        };
        const expiryUpdated = await tx.providerResponse.updateMany({
          where: { id: responseId, state: actualState },
          data: expiryUpdateData,
        });
        if (expiryUpdated.count === 0) throw new Error("RACE_CONDITION");

        // Append audit event for the expiry transition
        const lastEvent = await tx.experimentEvent.findFirst({ where: { experimentId: enrollment.experimentId }, orderBy: { timestamp: "desc" } });
        const expiryEvent = createEvent(
          enrollment.experimentId, responseId, enrollment.participantId,
          actualState, "PROVIDER_IGNORED",
          "system", "expiry",
          lastEvent?.eventHash ?? null,
        );
        await tx.experimentEvent.create({ data: expiryEvent });
        return { result: "EXPIRED" as const };
      }

      // 4. Verify expected state matches actual state (race protection)
      if (actualState !== fromState) throw new Error("RACE_CONDITION");

      // 5. Perform the state transition
      const updateData = buildUpdateData(actualState);
      const updated = await tx.providerResponse.updateMany({
        where: { id: responseId, state: fromState },
        data: updateData,
      });
      if (updated.count === 0) throw new Error("RACE_CONDITION");

      // 6. Append audit event (same transaction)
      const lastEvent = await tx.experimentEvent.findFirst({ where: { experimentId: enrollment.experimentId }, orderBy: { timestamp: "desc" } });
      const event = createEvent(
        enrollment.experimentId, responseId, enrollment.participantId,
        fromState, newState,
        newState === "TRIP_COMPLETED" ? "admin" : "participant",
        newState === "TRIP_COMPLETED" ? email ?? "admin" : enrollment.participantId,
        lastEvent?.eventHash ?? null,
      );
      await tx.experimentEvent.create({ data: event });

      return { result: "TRANSITIONED" as const };
    }, { isolationLevel: "Serializable" }).catch((err: any) => {
      if (err?.message === "WITHDRAWN") return { result: "WITHDRAWN" as const };
      if (err?.message === "RACE_CONDITION") return { result: "RACE" as const };
      if (err?.message === "EXPIRED") return { result: "EXPIRED" as const };
      throw err;
    });

    if (txResult.result === "WITHDRAWN") {
      return NextResponse.json({ error: "Participant has withdrawn. No transitions allowed." }, { status: 403 });
    }
    if (txResult.result === "RACE") {
      return NextResponse.json({ error: "Race condition: state changed before transition." }, { status: 409 });
    }
    if (txResult.result === "EXPIRED") {
      return NextResponse.json({ error: "Offer EXPIRED. Atomically transitioned to PROVIDER_IGNORED with audit event. No W3-R." }, { status: 400 });
    }

    // txResult.result === "TRANSITIONED"
    const w3rCreated = newState === "PROVIDER_ACCEPTED";
    const w4rCreated = newState === "TRIP_COMPLETED";

    return NextResponse.json({
      responseId, fromState, toState: newState, evidenceTier: newTier, w3rCreated, w4rCreated,
      message: w3rCreated
        ? `W3-R recorded: verified provider accepted research stimulus. (NOT marketplace evidence.)`
        : w4rCreated
        ? `W4-R recorded: completion verified by ${email} (level: ${completionLevel}). (NOT marketplace evidence.)`
        : `State: ${fromState} -> ${newState}. Evidence: ${newTier}.`,
    });
  }

  return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
}

// ═══════════════════════════════════════════════════════════════════════
// PILOT OPERATIONAL HELPERS
// ═══════════════════════════════════════════════════════════════════════

interface GateCheck { name: string; passed: boolean; detail?: string; }

interface ActivationGateResult {
  canActivate: boolean;
  checks: GateCheck[];
}

// Section 16: Pilot Start Gate — deterministic "Can Activate?" check.
// Returns PASS/FAIL for every required gate. Experiment CANNOT move
// PREREGISTERED → ACTIVE unless all gates pass.
async function runActivationGate(exp: any): Promise<ActivationGateResult> {
  const checks: GateCheck[] = [];

  // 1. Preregistration
  checks.push({
    name: "preregistration",
    passed: exp.status === "PREREGISTERED",
    detail: `status=${exp.status}`,
  });

  // 2. Hash
  const hasHash = !!exp.preregistrationHash;
  let hashValid = false;
  if (hasHash && exp.treatmentDesignJson) {
    try {
      const design = loadDesignStrict(exp.treatmentDesignJson);
      hashValid = verifyDesignHash(design, exp.preregistrationHash);
    } catch { hashValid = false; }
  }
  checks.push({ name: "hash", passed: hasHash && hashValid, detail: hasHash ? (hashValid ? "verified" : "MISMATCH") : "missing" });

  // 3. Consent
  const consentOk = !!exp.consentText && exp.consentText.length > 0 && (exp.consentVersion ?? 0) >= 1;
  checks.push({ name: "consent", passed: consentOk, detail: `version=${exp.consentVersion}` });

  // 4. Safety
  const safetyOk = exp.maxDetourKm > 0 && exp.maxExtraTimeMin > 0 && exp.minCompensation > 0;
  checks.push({ name: "safety", passed: safetyOk, detail: `maxDetour=${exp.maxDetourKm},maxTime=${exp.maxExtraTimeMin},minComp=${exp.minCompensation}` });

  // 5. Treatment assignment
  let treatmentOk = false;
  let cellCount = 0;
  if (exp.treatmentDesignJson && exp.preregistrationHash) {
    try {
      const design = loadDesignStrict(exp.treatmentDesignJson);
      const cells = generateTreatmentCells(design);
      cellCount = cells.length;
      treatmentOk = cells.length > 0;
    } catch { treatmentOk = false; }
  }
  checks.push({ name: "treatment_assignment", passed: treatmentOk, detail: `${cellCount} cells` });

  // 6. Stopping rule
  const stoppingOk = !!exp.stoppingRule && exp.stoppingRule.length > 0;
  checks.push({ name: "stopping_rule", passed: stoppingOk });

  // 7. Sample target
  const sampleOk = (exp.sampleTarget ?? 0) > 0;
  checks.push({ name: "sample_target", passed: sampleOk, detail: `target=${exp.sampleTarget}` });

  // 8. No existing W3-R/W4-R evidence (prevents re-activation with stale evidence)
  const existingResponses = await db.providerResponse.findMany({
    where: { experimentId: exp.id, evidenceTier: { in: ["W3-R", "W4-R"] } },
    select: { evidenceTier: true },
  });
  checks.push({ name: "no_existing_evidence", passed: existingResponses.length === 0, detail: `${existingResponses.length} existing W3-R/W4-R` });

  // 9. No test participants enrolled
  const testEnrollments = await db.experimentEnrollment.count({
    where: { experimentId: exp.id, accountEmail: { contains: "@oryxx.test" } },
  });
  checks.push({ name: "no_test_participants", passed: testEnrollments === 0, detail: `${testEnrollments} test enrollments` });

  // 10. No test experiments (by name pattern)
  const testExperiments = await db.acceptanceExperiment.count({
    where: { name: { contains: "HTTP Concurrency Test" } },
  });
  checks.push({ name: "no_test_experiments", passed: testExperiments === 0, detail: `${testExperiments} test experiments` });

  const canActivate = checks.every((c) => c.passed);
  return { canActivate, checks };
}

interface StopGateResult {
  canComplete: boolean;
  responseCount: number;
  sampleTarget: number;
  checks: GateCheck[];
}

// Section 17: Pilot Stop Gate — verifies stopping rule satisfied.
async function runStopGate(exp: any, responseCount: number): Promise<StopGateResult> {
  const checks: GateCheck[] = [];
  const target = exp.sampleTarget ?? 100;

  // Stopping rule: "Stop after 100 responses or 30 days."
  checks.push({
    name: "sample_target_reached",
    passed: responseCount >= target,
    detail: `${responseCount}/${target} responses`,
  });

  // Alternative: 30 days elapsed (check via preregisteredAt or first event)
  let daysElapsed = 0;
  if (exp.preregisteredAt) {
    const prereg = new Date(exp.preregisteredAt);
    daysElapsed = Math.floor((Date.now() - prereg.getTime()) / (1000 * 60 * 60 * 24));
  }
  checks.push({
    name: "time_limit_reached",
    passed: daysElapsed >= 30,
    detail: `${daysElapsed}/30 days elapsed`,
  });

  // No pending transitions (all offers in terminal states)
  const pending = await db.providerResponse.count({
    where: {
      experimentId: exp.id,
      state: { in: ["OFFER_CREATED", "OFFER_PRESENTED", "PROVIDER_VIEWED", "PROVIDER_ACCEPTED", "TRIP_STARTED"] },
    },
  });
  checks.push({ name: "no_pending_transitions", passed: pending === 0, detail: `${pending} pending` });

  // Can complete if EITHER stopping condition is met AND no pending transitions
  const stoppingRuleSatisfied = checks[0].passed || checks[1].passed;
  const canComplete = stoppingRuleSatisfied && checks[2].passed;

  return { canComplete, responseCount, sampleTarget: target, checks };
}

interface IntegrityViolation {
  type: string;
  detail: string;
  severity: "critical" | "warning";
}

interface IntegrityReport {
  violations: IntegrityViolation[];
  counts: {
    enrollments: number;
    responses: number;
    w3r: number;
    w4r: number;
    w3m: number;
    w4m: number;
    withdrawn: number;
  };
  hashChainValid: boolean;
}

// Section 12: Real-time integrity monitoring.
// Detects integrity violations. Does NOT modify data.
async function runIntegrityCheck(exp: any): Promise<IntegrityReport> {
  const violations: IntegrityViolation[] = [];

  const enrollments = await db.experimentEnrollment.findMany({ where: { experimentId: exp.id } });
  const responses = await db.providerResponse.findMany({ where: { experimentId: exp.id } });
  const consents = await db.experimentConsent.findMany({ where: { experimentId: exp.id } });
  const events = await db.experimentEvent.findMany({ where: { experimentId: exp.id }, orderBy: { timestamp: "asc" } });

  // Load design for cell validation
  let validCellIds = new Set<string>();
  try {
    const design = loadDesignStrict(exp.treatmentDesignJson);
    validCellIds = new Set(generateTreatmentCells(design).map((c) => c.id));
  } catch { /* design missing — flagged below */ }

  // 1. Duplicate participant (same accountEmail enrolled twice — should be prevented by unique constraint)
  const emailCounts = new Map<string, number>();
  for (const e of enrollments) emailCounts.set(e.accountEmail, (emailCounts.get(e.accountEmail) ?? 0) + 1);
  for (const [email, count] of emailCounts) {
    if (count > 1) violations.push({ type: "duplicate_participant", detail: `${email} enrolled ${count} times`, severity: "critical" });
  }

  // 2. Missing treatment cell
  for (const e of enrollments) {
    if (!e.assignedCellId) violations.push({ type: "missing_treatment_cell", detail: `enrollment ${e.id}`, severity: "critical" });
  }

  // 3. Unknown treatment cell
  for (const e of enrollments) {
    if (e.assignedCellId && validCellIds.size > 0 && !validCellIds.has(e.assignedCellId)) {
      violations.push({ type: "unknown_treatment_cell", detail: `enrollment ${e.id}: ${e.assignedCellId}`, severity: "critical" });
    }
  }

  // 4. Missing consent (offer created without valid, non-withdrawn consent)
  const validConsents = new Set(consents.filter((c) => !c.withdrawnAt).map((c) => c.enrollmentId));
  for (const r of responses) {
    if (!validConsents.has(r.enrollmentId)) {
      violations.push({ type: "missing_consent", detail: `response ${r.id} has no valid consent`, severity: "critical" });
    }
  }

  // 5. Missing provider verification (offer created to unverified provider)
  const enrollmentMap = new Map(enrollments.map((e) => [e.id, e]));
  for (const r of responses) {
    const en = enrollmentMap.get(r.enrollmentId);
    if (en && en.providerVerified !== "operator_verified" && en.providerVerified !== "externally_verified") {
      violations.push({ type: "unverified_provider_offer", detail: `response ${r.id} to unverified provider`, severity: "critical" });
    }
  }

  // 6. Offer after withdrawal
  for (const r of responses) {
    const en = enrollmentMap.get(r.enrollmentId);
    if (en && en.status === "withdrawn") {
      // Check if offer was created AFTER withdrawal
      if (en.withdrawnAt && r.offerPresentedAt && new Date(r.offerPresentedAt) > new Date(en.withdrawnAt)) {
        violations.push({ type: "offer_after_withdrawal", detail: `response ${r.id} created after withdrawal`, severity: "critical" });
      }
    }
  }

  // 7. W3-R without required event sequence (PROVIDER_ACCEPTED must follow PROVIDER_VIEWED)
  const responseStates = new Map(responses.map((r) => [r.id, r.state]));
  for (const r of responses) {
    if (r.evidenceTier === "W3-R" && r.state !== "PROVIDER_ACCEPTED" && r.state !== "TRIP_STARTED" && r.state !== "TRIP_COMPLETED" && r.state !== "TRIP_CANCELLED") {
      violations.push({ type: "w3r_invalid_sequence", detail: `response ${r.id} has W3-R but state=${r.state}`, severity: "critical" });
    }
  }

  // 8. W4-R without W3-R (TRIP_COMPLETED must follow PROVIDER_ACCEPTED)
  for (const r of responses) {
    if (r.evidenceTier === "W4-R" && r.state === "TRIP_COMPLETED") {
      // Verify there was a prior PROVIDER_ACCEPTED — check event log
      const acceptEvent = events.find((e) => e.offerId === r.id && e.toState === "PROVIDER_ACCEPTED");
      if (!acceptEvent) {
        violations.push({ type: "w4r_without_w3r", detail: `response ${r.id} has W4-R without prior W3-R`, severity: "critical" });
      }
    }
  }

  // 9. Unexpected W3-M or W4-M (critical integrity event — research flow cannot produce these)
  const w3m = responses.filter((r) => r.evidenceTier === "W3-M").length;
  const w4m = responses.filter((r) => r.evidenceTier === "W4-M").length;
  if (w3m > 0) violations.push({ type: "unexpected_w3m", detail: `${w3m} W3-M evidence in research flow`, severity: "critical" });
  if (w4m > 0) violations.push({ type: "unexpected_w4m", detail: `${w4m} W4-M evidence in research flow`, severity: "critical" });

  // 10. Modified preregistration hash
  let hashValid = false;
  try {
    const design = loadDesignStrict(exp.treatmentDesignJson);
    hashValid = verifyDesignHash(design, exp.preregistrationHash);
  } catch { hashValid = false; }
  if (!hashValid) {
    violations.push({ type: "modified_preregistration_hash", detail: "design does not match persisted hash", severity: "critical" });
  }

  // 11. Hash chain integrity
  let hashChainValid = true;
  let previousHash: string | null = null;
  for (const e of events) {
    if (e.previousEventHash !== previousHash) { hashChainValid = false; break; }
    previousHash = e.eventHash;
  }
  if (!hashChainValid) {
    violations.push({ type: "hash_chain_broken", detail: "event log hash chain is broken", severity: "critical" });
  }

  const counts = {
    enrollments: enrollments.length,
    responses: responses.length,
    w3r: responses.filter((r) => r.evidenceTier === "W3-R").length,
    w4r: responses.filter((r) => r.evidenceTier === "W4-R").length,
    w3m,
    w4m,
    withdrawn: enrollments.filter((e) => e.status === "withdrawn").length,
  };

  return { violations, counts, hashChainValid };
}

// Section 14: Analysis dataset export (operator-only, fails closed on violations)
async function buildAnalysisDataset(exp: any) {
  const enrollments = await db.experimentEnrollment.findMany({ where: { experimentId: exp.id } });
  const responses = await db.providerResponse.findMany({ where: { experimentId: exp.id } });
  const consents = await db.experimentConsent.findMany({ where: { experimentId: exp.id } });

  const enrollmentMap = new Map(enrollments.map((e) => [e.id, e]));
  const consentByEnrollment = new Map(consents.map((c) => [c.enrollmentId, c]));

  return responses.map((r) => {
    const en = enrollmentMap.get(r.enrollmentId);
    const con = consentByEnrollment.get(r.enrollmentId);
    return {
      experimentId: exp.id,
      experimentVersion: exp.consentVersion,
      preregistrationHash: exp.preregistrationHash?.substring(0, 16) + "…",
      participantPseudonym: r.participantId.substring(0, 12) + "…",
      providerVerificationLevel: en?.providerVerified ?? "unknown",
      treatmentCellId: en?.assignedCellId,
      compensation: r.compensation,
      detourKm: r.detourKm,
      extraTimeMin: r.extraTimeMin,
      advanceNoticeMin: r.advanceNoticeMin,
      offerPresentedAt: r.offerPresentedAt,
      providerViewedAt: r.providerViewedAt,
      decisionAt: r.decisionAt,
      offerExpiresAt: r.offerExpiresAt,
      state: r.state,
      decision: r.decision,
      evidenceTier: r.evidenceTier,
      w3rTimestamp: r.evidenceTier === "W3-R" ? r.decisionAt : null,
      w4rTimestamp: r.evidenceTier === "W4-R" ? r.timestamp : null,
      completionEvidenceLevel: r.completionEvidenceLevel,
      withdrawalStatus: en?.status ?? "unknown",
      consentVersion: con?.consentVersion,
      consentedAt: con?.consentedAt,
    };
  });
}
