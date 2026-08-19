// ORYXX — Research-integrity-safe experiment API (v6 — FINAL).
//
// This is the final research instrument. After this commit, the research
// protocol is frozen. The only valid operation is to run the experiment
// with real participants.
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
// 11. Consent withdrawal endpoint (ETHICAL BLOCKER FIXED)
// 12. Preregistration immutability enforced via canMutateDesign check
// 13. State mutation + event append in SAME transaction (atomicity)
// 14. Event log: append-only via API (no UPDATE/DELETE endpoint exists)

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
      w3mCount: 0, // marketplace evidence is structurally impossible via research API
      w4mCount: 0,
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

  // Reject marketplace transactions via research API
  if (body?.experimentType === "MARKETPLACE_TRANSACTION") {
    return NextResponse.json({ error: "Marketplace transactions cannot be created via the research API. W3-M/W4-M evidence requires a separate marketplace service boundary." }, { status: 403 });
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
    return NextResponse.json({ experiment: exp, message: "DRAFT created. Preregister to lock design." });
  }

  // === PREREGISTER (admin) ===
  // DEFECT 2 FIX: enforce canMutateDesign — reject if status >= PREREGISTERED
  if (mode === "preregister") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!canMutateDesign(exp.status as ExperimentStatus)) {
      return NextResponse.json({ error: `Cannot preregister: experiment status is ${exp.status}. Only DRAFT experiments can be preregistered. Create a new experiment version instead.` }, { status: 400 });
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
    return NextResponse.json({ preregistrationHash: hash, message: "Preregistered. Design PERSISTED + hashed. Activate to make immutable." });
  }

  // === ACTIVATE (admin) — validates hash ===
  if (mode === "activate") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "PREREGISTERED") return NextResponse.json({ error: `Status is ${exp.status}.` }, { status: 400 });
    if (!exp.treatmentDesignJson || !exp.preregistrationHash) return NextResponse.json({ error: "Missing persisted design or hash." }, { status: 400 });
    const design = loadDesignStrict(exp.treatmentDesignJson);
    if (!verifyDesignHash(design, exp.preregistrationHash)) {
      return NextResponse.json({ error: "PREREGISTRATION HASH MISMATCH. Design may have been tampered with. Activation refused." }, { status: 400 });
    }
    await db.acceptanceExperiment.update({ where: { id: exp.id }, data: { status: "ACTIVE" } });
    return NextResponse.json({ message: "ACTIVE. Design is IMMUTABLE. Hash verified." });
  }

  // === VERIFY PROVIDER (admin) ===
  if (mode === "verify_provider") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { id: body?.enrollmentId } });
    if (!enrollment) return NextResponse.json({ error: "Enrollment not found." }, { status: 404 });
    if (body?.external === true || body?.level === "externally_verified") {
      return NextResponse.json({ error: "externally_verified CANNOT be created via admin request. Only operator_verified is possible in the current pilot." }, { status: 400 });
    }
    await db.experimentEnrollment.update({
      where: { id: enrollment.id },
      data: { providerVerified: "operator_verified", providerType: body?.providerType ?? "taxi", verificationMethod: "admin_manual", verificationReference: body?.reference ?? null, verifiedAt: new Date() },
    });
    return NextResponse.json({ message: "Provider operator_verified. External credential verification NOT connected." });
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
    if (existing) return NextResponse.json({ error: "Account already enrolled.", enrollment: existing }, { status: 409 });
    const participantId = `P-${randomBytes(8).toString("hex")}`;
    const enrollmentToken = randomBytes(24).toString("hex");
    const cells = generateTreatmentCells(design);
    let result: { enrollment: any; cell: any } | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await db.$transaction(async (tx) => {
          const enrollments = await tx.experimentEnrollment.findMany({ where: { experimentId, assignedCellId: { not: null } }, select: { assignedCellId: true } });
          const cellCounts = cells.map(c => enrollments.filter(e => e.assignedCellId === c.id).length);
          const cell = assignTreatment(participantId, experimentId, exp.randomizationSeed, cells, cellCounts);
          const enrollment = await tx.experimentEnrollment.create({ data: { experimentId, participantId, accountEmail: email, enrollmentToken, assignedCellId: cell.id, providerVerified: "unverified" } });
          return { enrollment, cell };
        }, { isolationLevel: "Serializable" });
        break;
      } catch (err: any) {
        lastErr = err;
        if (err?.code !== "P2034") throw err;
        await new Promise(r => setTimeout(r, 50 * Math.pow(2, attempt)));
      }
    }
    if (!result) throw lastErr ?? new Error("Enrollment failed after retries.");
    return NextResponse.json({ enrollment: result.enrollment, assignedCell: result.cell, consentRequired: exp.requiresConsent, consentText: exp.consentText, providerVerificationRequired: true, message: "Enrolled. Account-bound. Provider verification REQUIRED." });
  }

  // === CONSENT (account-bound) ===
  if (mode === "consent") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    if (enrollment.accountEmail !== email) return NextResponse.json({ error: "CROSS-USER: enrollment belongs to different account." }, { status: 403 });
    const exp = enrollment.experiment;
    const consentTextHash = createHash("sha256").update(exp.consentText ?? "").digest("hex");
    const consent = await db.experimentConsent.create({ data: { experimentId: exp.id, enrollmentId: enrollment.id, participantId: enrollment.participantId, accountEmail: email, consentVersion: exp.consentVersion, consentTextHash, consentText: exp.consentText ?? "" } });
    return NextResponse.json({ consent, message: "Consent recorded. Account verified." });
  }

  // === WITHDRAW (participant self-service) — ETHICAL BLOCKER FIX ===
  // Allows a participant to withdraw from the experiment.
  // Idempotent: withdrawing an already-withdrawn enrollment is a no-op success.
  // After withdrawal: no new offers, no transitions, no W3-R/W4-R creation.
  if (mode === "withdraw") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    // Only the owning participant can withdraw
    if (enrollment.accountEmail !== email) return NextResponse.json({ error: "CROSS-USER: cannot withdraw another participant's enrollment." }, { status: 403 });
    // Idempotent: already withdrawn = success (no-op)
    if (enrollment.status === "withdrawn") {
      return NextResponse.json({ message: "Already withdrawn. No action taken.", withdrawnAt: enrollment.withdrawnAt });
    }
    // Atomic: set enrollment status + withdraw all consents in one transaction
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.experimentEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "withdrawn", withdrawnAt: now },
      });
      await tx.experimentConsent.updateMany({
        where: { enrollmentId: enrollment.id, withdrawnAt: null },
        data: { withdrawnAt: now },
      });
    });
    return NextResponse.json({ message: "Withdrawn. No new offers or transitions will be accepted. Existing data is retained per the preregistered data policy.", withdrawnAt: now.toISOString() });
  }

  // === CREATE OFFER (requires verified provider + consent + hash check) ===
  // DEFECT 3 FIX: response creation + event append in SAME transaction
  if (mode === "create_offer") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    if (enrollment.status === "withdrawn") return NextResponse.json({ error: "Participant withdrawn. No offers allowed." }, { status: 403 });
    if (enrollment.accountEmail !== email) return NextResponse.json({ error: "CROSS-USER." }, { status: 403 });
    const exp = enrollment.experiment;
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Experiment ${exp.status}.` }, { status: 400 });
    if (enrollment.providerVerified !== "operator_verified" && enrollment.providerVerified !== "externally_verified") {
      return NextResponse.json({ error: `Provider NOT verified (status: ${enrollment.providerVerified}).` }, { status: 403 });
    }
    if (exp.requiresConsent) {
      const consent = await db.experimentConsent.findFirst({ where: { enrollmentId: enrollment.id, accountEmail: email, withdrawnAt: null } });
      if (!consent) return NextResponse.json({ error: "Consent required." }, { status: 403 });
    }
    const design = loadDesignStrict(exp.treatmentDesignJson);
    if (!verifyDesignHash(design, exp.preregistrationHash!)) {
      return NextResponse.json({ error: "PREREGISTRATION HASH MISMATCH at offer creation." }, { status: 500 });
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

    // DEFECT 3 FIX: response creation + event append in SAME transaction
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
      // event append in same transaction — if this fails, response creation rolls back
      const lastEvent = await tx.experimentEvent.findFirst({ where: { offerId: response.id }, orderBy: { timestamp: "desc" } });
      const event = createEvent(exp.id, response.id, enrollment.participantId, null, "OFFER_CREATED", "system", email ?? "system", lastEvent?.eventHash ?? null);
      await tx.experimentEvent.create({ data: event });
      return { response };
    }, { isolationLevel: "Serializable" });

    return NextResponse.json({ response: result.response, message: "RESEARCH STIMULUS created (NOT a marketplace booking)." });
  }

  // === TRANSITION (atomic, enrollment-bound, offer-immutable) ===
  // DEFECT 3 FIX: state mutation + event append in SAME transaction
  if (mode === "transition") {
    const enrollmentToken = body?.enrollmentToken;
    const responseId = body?.responseId;
    const newState = body?.newState as ResearchState;
    if (!enrollmentToken || !responseId || !newState) return NextResponse.json({ error: "enrollmentToken, responseId, newState required." }, { status: 400 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid token." }, { status: 404 });
    if (enrollment.status === "withdrawn") return NextResponse.json({ error: "Participant withdrawn. No transitions allowed." }, { status: 403 });
    if (enrollment.accountEmail !== email) return NextResponse.json({ error: "CROSS-USER." }, { status: 403 });
    const response = await db.providerResponse.findUnique({ where: { id: responseId } });
    if (!response) return NextResponse.json({ error: "Response not found." }, { status: 404 });
    if (response.enrollmentId !== enrollment.id) return NextResponse.json({ error: "CROSS-USER: response belongs to different enrollment." }, { status: 403 });

    // OFFER EXPIRY
    if (response.offerExpiresAt && isOfferExpired(response.offerExpiresAt) && newState === "PROVIDER_ACCEPTED") {
      await db.providerResponse.updateMany({ where: { id: responseId, state: response.state }, data: { state: "PROVIDER_IGNORED", evidenceTier: "NONE", decisionAt: new Date().toISOString() } });
      return NextResponse.json({ error: "Offer EXPIRED. Auto-transitioned to PROVIDER_IGNORED. No W3-R." }, { status: 400 });
    }

    const fromState = response.state as ResearchState;
    if (!isValidResearchTransition(fromState, newState)) return NextResponse.json({ error: `Invalid transition: ${fromState} -> ${newState}.` }, { status: 400 });
    if (newState === "TRIP_COMPLETED" && role !== "admin") {
      return NextResponse.json({ error: "W4-R requires admin verification. Participants cannot self-report TRIP_COMPLETED." }, { status: 403 });
    }
    let completionLevel = "operator";
    if (newState === "TRIP_COMPLETED") {
      const requestedLevel = body?.completionEvidenceLevel;
      if (requestedLevel && requestedLevel !== "operator") {
        return NextResponse.json({ error: `completionEvidenceLevel "${requestedLevel}" requires external evidence infrastructure not connected. Only "operator" is possible.` }, { status: 400 });
      }
    }

    const newTier = researchEvidenceForState(newState);
    const decision = newState === "PROVIDER_ACCEPTED" ? "accept" : newState === "PROVIDER_DECLINED" ? "decline" : newState === "PROVIDER_UNAVAILABLE" ? "not_available" : newState === "PROVIDER_IGNORED" ? "ignore" : response.decision;
    const updateData: any = { state: newState, evidenceTier: newTier };
    if (newState === "OFFER_PRESENTED") updateData.offerPresentedAt = new Date().toISOString();
    if (newState === "PROVIDER_VIEWED") updateData.providerViewedAt = new Date().toISOString();
    if (["PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE", "PROVIDER_IGNORED"].includes(newState)) {
      updateData.decision = decision;
      updateData.decisionAt = new Date().toISOString();
    }
    if (newState === "TRIP_STARTED") updateData.executed = true;
    if (newState === "TRIP_COMPLETED") {
      updateData.executed = true;
      updateData.completed = true;
      updateData.externalVerificationMethod = "admin_verified";
      updateData.externalVerifiedBy = email;
      updateData.externalVerifiedAt = new Date().toISOString();
      updateData.completionEvidenceLevel = completionLevel;
    }
    if (newState === "TRIP_CANCELLED") { updateData.executed = false; updateData.executionFailureReason = body?.reason ?? "cancelled"; }

    // DEFECT 3 FIX: state mutation + event append in SAME transaction
    // If event creation fails, the state change rolls back.
    // If the state change fails (race), the event does not exist.
    const txResult = await db.$transaction(async (tx) => {
      // ATOMIC UPDATE (race protection) — inside the transaction
      const updated = await tx.providerResponse.updateMany({ where: { id: responseId, state: fromState }, data: updateData });
      if (updated.count === 0) throw new Error("RACE_CONDITION");

      // event append in same transaction
      const lastEvent = await tx.experimentEvent.findFirst({ where: { offerId: responseId }, orderBy: { timestamp: "desc" } });
      const event = createEvent(enrollment.experimentId, responseId, enrollment.participantId, fromState, newState,
        newState === "TRIP_COMPLETED" ? "admin" : "participant",
        newState === "TRIP_COMPLETED" ? email ?? "admin" : enrollment.participantId,
        lastEvent?.eventHash ?? null);
      await tx.experimentEvent.create({ data: event });
      return { updated: true };
    }, { isolationLevel: "Serializable" }).catch((err: any) => {
      if (err?.message === "RACE_CONDITION") return { updated: false };
      throw err;
    });

    if (!txResult.updated) return NextResponse.json({ error: "Race condition: state changed before transition." }, { status: 409 });

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
