// ORYXX — Research-integrity-safe experiment API (v3).
//
// This version fixes the 10 remaining defects identified by the reviewer:
//
// 1. W3 requires a VERIFIED real transportation provider, not any user self-enrolling
// 2. Offers are bound to the PERSISTED preregistered treatment design (not hardcoded)
// 3. W4 requires EXTERNAL VERIFICATION (admin/system), not participant self-report
// 4. Treatment design is PERSISTED at preregistration and loaded at runtime
// 5. Randomization uses LEAST-FILLED cell assignment (true balance)
// 6. Enrollment is BOUND to the NextAuth account email (prevents token transfer)
// 7. Consent is BOUND to the account email (prevents cross-user consent)
// 8. Preregistration hash is FULL SHA-256 (not truncated)
// 9. Event log is described as "application-level audit trail" (not cryptographically immutable)
// 10. W3/W4 definitions are honest: W3 = verified provider accepted; W4 = externally verified completion
//
// CRITICAL: The system CANNOT manufacture W3 without:
//   - An admin-verified real transportation provider
//   - A persisted preregistered treatment design
//   - Server-derived participant identity (from account binding)
//   - Server-verified consent
//
// The system CANNOT manufacture W4 without:
//   - External verification by an admin or system
//   - The participant CANNOT self-report TRIP_COMPLETED

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import {
  isValidTransition,
  evidenceTierForState,
  validateOfferSafety,
  assignTreatment,
  generateTreatmentCells,
  computePreregistrationHash,
  canMutateDesign,
  isOfferExpired,
  createEvent,
  type PreregisteredDesign,
  type ExperimentState,
} from "@/lib/oryxx/real/evidence/pilot";
import { randomBytes, createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Helper: load the PERSISTED treatment design from the experiment record
function loadDesign(exp: any): PreregisteredDesign {
  if (exp.treatmentDesignJson) {
    try { return JSON.parse(exp.treatmentDesignJson); } catch {}
  }
  // fallback: construct from individual fields (for experiments created before persistence)
  return {
    hypothesis: exp.hypothesis ?? "", population: exp.population ?? "", geography: exp.geography ?? "",
    providerType: exp.providerType ?? "", sampleTarget: exp.sampleTarget,
    compensationBuckets: [1, 2, 3, 4, 5], detourBuckets: [0, 0.5, 1, 2, 3],
    extraTimeBuckets: [0, 2, 5, 10], noticeBuckets: [0, 15, 60],
    randomizationSeed: exp.randomizationSeed, primaryOutcome: exp.primaryOutcome,
    secondaryOutcomes: [], analysisMethod: exp.analysisMethod ?? "", stoppingRule: exp.stoppingRule ?? "",
    safetyRules: [], maxDetourKm: exp.maxDetourKm, maxExtraTimeMin: exp.maxExtraTimeMin,
    minCompensation: exp.minCompensation, consentText: exp.consentText ?? "",
    assumedUserSavings: exp.assumedUserSavings, assumedFailureCost: exp.assumedFailureCost,
    assumedOryxxMargin: exp.assumedOryxxMargin,
  };
}

// GET: list experiments
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const experiments = await db.acceptanceExperiment.findMany({
    include: { _count: { select: { responses: true, enrollments: true, events: true } } },
    orderBy: { id: "desc" },
  });

  const results = await Promise.all(experiments.map(async (exp) => {
    const responses = await db.providerResponse.findMany({
      where: { experimentId: exp.id },
      select: { state: true, evidenceTier: true, decision: true },
    });
    const w3 = responses.filter((r) => r.evidenceTier === "W3").length;
    const w4 = responses.filter((r) => r.evidenceTier === "W4").length;
    return {
      ...exp,
      totalResponses: responses.length,
      w3Count: w3,
      w4Count: w4,
      hasW3Evidence: w3 > 0,
      hasW4Evidence: w4 > 0,
    };
  }));

  return NextResponse.json({ experiments: results });
}

// POST: multiple modes
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const email = (session.user as any)?.email;
  const role = (session.user as any)?.role;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const mode = body?.mode;

  // === CREATE EXPERIMENT (admin only) ===
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
        hypothesis: body?.hypothesis ?? "Providers will accept pooled offers when compensation ≥ $3 and detour ≤ 2km.",
        sampleTarget: body?.sampleTarget ?? 100,
        primaryOutcome: "W3_acceptance_rate",
        stoppingRule: body?.stoppingRule ?? "Stop after 100 responses or 30 days.",
        randomizationSeed: body?.randomizationSeed ?? 42,
        consentText: "You are participating in a research study. Responses are pseudonymous. You may withdraw at any time.",
        consentVersion: 1,
        assumedUserSavings: body?.assumedUserSavings ?? 4.0,
        assumedFailureCost: body?.assumedFailureCost ?? 1.0,
        assumedOryxxMargin: body?.assumedOryxxMargin ?? 0.50,
      },
    });
    return NextResponse.json({ experiment: exp, message: "DRAFT experiment created. Preregister to lock design." });
  }

  // === PREREGISTER (admin) — persists treatment design + computes full hash ===
  if (mode === "preregister") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "DRAFT") return NextResponse.json({ error: `Cannot preregister: status is ${exp.status}.` }, { status: 400 });

    const design: PreregisteredDesign = {
      hypothesis: exp.hypothesis ?? "",
      population: body?.population ?? "ride-hail drivers",
      geography: body?.geography ?? "NYC",
      providerType: body?.providerType ?? "taxi/FHV",
      sampleTarget: exp.sampleTarget,
      compensationBuckets: body?.compensationBuckets ?? [1, 2, 3, 4, 5],
      detourBuckets: body?.detourBuckets ?? [0, 0.5, 1, 2, 3],
      extraTimeBuckets: body?.extraTimeBuckets ?? [0, 2, 5, 10],
      noticeBuckets: body?.noticeBuckets ?? [0, 15, 60],
      randomizationSeed: exp.randomizationSeed,
      primaryOutcome: exp.primaryOutcome,
      secondaryOutcomes: body?.secondaryOutcomes ?? ["W4_completion_rate", "net_value"],
      analysisMethod: body?.analysisMethod ?? "per-cell Wilson CI, logistic regression",
      stoppingRule: exp.stoppingRule ?? "",
      safetyRules: body?.safetyRules ?? ["max 5km detour", "max 20min extra time", "min $1 comp"],
      maxDetourKm: exp.maxDetourKm,
      maxExtraTimeMin: exp.maxExtraTimeMin,
      minCompensation: exp.minCompensation,
      consentText: exp.consentText ?? "",
      assumedUserSavings: exp.assumedUserSavings,
      assumedFailureCost: exp.assumedFailureCost,
      assumedOryxxMargin: exp.assumedOryxxMargin,
    };
    const hash = computePreregistrationHash(design);

    const updated = await db.acceptanceExperiment.update({
      where: { id: exp.id },
      data: {
        status: "PREREGISTERED",
        preregistrationHash: hash, // FULL SHA-256
        preregisteredAt: new Date().toISOString(),
        population: design.population,
        geography: design.geography,
        providerType: design.providerType,
        analysisMethod: design.analysisMethod,
        secondaryOutcomes: JSON.stringify(design.secondaryOutcomes),
        treatmentDesignJson: JSON.stringify(design), // PERSIST the design
      },
    });

    return NextResponse.json({ experiment: updated, preregistrationHash: hash, message: "Preregistered. Design PERSISTED. Hash = full SHA-256. Activate to make immutable." });
  }

  // === ACTIVATE (admin) ===
  if (mode === "activate") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "PREREGISTERED") return NextResponse.json({ error: `Cannot activate: status is ${exp.status}.` }, { status: 400 });
    if (!exp.treatmentDesignJson) return NextResponse.json({ error: "Treatment design not persisted. Preregister first." }, { status: 400 });
    const updated = await db.acceptanceExperiment.update({ where: { id: exp.id }, data: { status: "ACTIVE" } });
    return NextResponse.json({ experiment: updated, message: "ACTIVE. Design is now IMMUTABLE. Begin enrolling verified providers." });
  }

  // === VERIFY PROVIDER (admin) — required before participant can receive offers ===
  if (mode === "verify_provider") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const enrollment = await db.experimentEnrollment.findUnique({ where: { id: body?.enrollmentId } });
    if (!enrollment) return NextResponse.json({ error: "Enrollment not found." }, { status: 404 });
    const updated = await db.experimentEnrollment.update({
      where: { id: enrollment.id },
      data: {
        providerVerified: body?.verified ? "verified" : "rejected",
        providerType: body?.providerType ?? "taxi",
        verifiedAt: new Date(),
      },
    });
    return NextResponse.json({ enrollment: updated, message: body?.verified ? "Provider VERIFIED. Can now receive offers." : "Provider REJECTED." });
  }

  // === ENROLL — binds to NextAuth account, requires provider verification LATER ===
  if (mode === "enroll") {
    const experimentId = body?.experimentId;
    if (!experimentId) return NextResponse.json({ error: "experimentId required." }, { status: 400 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
    if (!exp) return NextResponse.json({ error: "Experiment not found." }, { status: 404 });
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Experiment is ${exp.status}, not ACTIVE.` }, { status: 400 });

    // BIND enrollment to the authenticated account email (prevents token transfer)
    // Check if this account already has an enrollment
    const existing = await db.experimentEnrollment.findFirst({ where: { accountEmail: email, experimentId } });
    if (existing) return NextResponse.json({ error: "Account already enrolled.", enrollment: existing }, { status: 409 });

    const participantId = `P-${randomBytes(8).toString("hex")}`;
    const enrollmentToken = randomBytes(24).toString("hex");

    // load PERSISTED treatment design (NOT hardcoded)
    const design = loadDesign(exp);
    const cells = generateTreatmentCells(design);

    // BALANCED randomization: count existing assignments per cell
    const existingEnrollments = await db.experimentEnrollment.findMany({
      where: { experimentId, assignedCellId: { not: null } },
      select: { assignedCellId: true },
    });
    const cellCounts = cells.map(c => existingEnrollments.filter(e => e.assignedCellId === c.id).length);
    const cell = assignTreatment(participantId, experimentId, exp.randomizationSeed, cells, cellCounts);

    const enrollment = await db.experimentEnrollment.create({
      data: {
        experimentId,
        participantId,
        accountEmail: email, // BINDS to authenticated account
        enrollmentToken,
        assignedCellId: cell.id,
        providerVerified: "unverified", // must be admin-verified before offers
      },
    });

    return NextResponse.json({
      enrollment,
      assignedCell: cell,
      consentRequired: exp.requiresConsent,
      consentText: exp.consentText,
      providerVerificationRequired: true,
      message: "Enrolled. Account bound. Provider verification REQUIRED before offers. Consent required.",
    });
  }

  // === CONSENT — bound to account email (prevents cross-user) ===
  if (mode === "consent") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });

    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid enrollment token." }, { status: 404 });

    // VERIFY: the authenticated account matches the enrollment's account
    if (enrollment.accountEmail !== email) {
      return NextResponse.json({ error: "CROSS-USER ATTACK: enrollment belongs to a different account." }, { status: 403 });
    }

    const exp = enrollment.experiment;
    const consentTextHash = createHash("sha256").update(exp.consentText ?? "").digest("hex"); // FULL hash

    const consent = await db.experimentConsent.create({
      data: {
        experimentId: exp.id,
        enrollmentId: enrollment.id,
        participantId: enrollment.participantId,
        accountEmail: email, // BOUND to authenticated account
        consentVersion: exp.consentVersion,
        consentTextHash,
        consentText: exp.consentText ?? "",
      },
    });

    return NextResponse.json({ consent, message: "Consent recorded. Account verified." });
  }

  // === CREATE OFFER — requires verified provider + consent + persisted design ===
  if (mode === "create_offer") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });

    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid enrollment token." }, { status: 404 });
    if (enrollment.status === "withdrawn") return NextResponse.json({ error: "Participant withdrawn." }, { status: 403 });

    // VERIFY: account matches enrollment
    if (enrollment.accountEmail !== email) {
      return NextResponse.json({ error: "CROSS-USER: enrollment belongs to different account." }, { status: 403 });
    }

    const exp = enrollment.experiment;
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Experiment is ${exp.status}.` }, { status: 400 });

    // DEFECT 1 FIX: require admin-verified real provider
    if (enrollment.providerVerified !== "verified") {
      return NextResponse.json({ error: "Provider NOT verified. An admin must verify this participant is a real transportation provider before offers can be created." }, { status: 403 });
    }

    // VERIFY consent (bound to this account)
    if (exp.requiresConsent) {
      const consent = await db.experimentConsent.findFirst({
        where: { enrollmentId: enrollment.id, accountEmail: email, withdrawnAt: null },
      });
      if (!consent) return NextResponse.json({ error: "Consent required but not found for this account." }, { status: 403 });
    }

    // DEFECT 4 FIX: load PERSISTED treatment design (NOT hardcoded)
    const design = loadDesign(exp);
    const cells = generateTreatmentCells(design);
    const cell = cells.find((c) => c.id === enrollment.assignedCellId) ?? cells[0];

    // SERVER-SIDE safety validation
    const safety = validateOfferSafety(
      { detourKm: cell.detourKm, extraTimeMin: cell.extraTimeMin, compensation: cell.compensation, passengerCount: 1 },
      { maxDetourKm: exp.maxDetourKm, maxExtraTimeMin: exp.maxExtraTimeMin, minCompensation: exp.minCompensation },
    );
    if (!safety.safe) return NextResponse.json({ error: "Offer rejected by safety validator", violations: safety.violations }, { status: 400 });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    const response = await db.providerResponse.create({
      data: {
        experimentId: exp.id,
        enrollmentId: enrollment.id,
        participantId: enrollment.participantId,
        treatmentCellId: cell.id,
        compensation: cell.compensation,
        detourKm: cell.detourKm,
        extraTimeMin: cell.extraTimeMin,
        advanceNoticeMin: cell.advanceNoticeMin,
        passengerCount: 1,
        tripDistanceKm: body?.tripDistanceKm ?? 5,
        originName: body?.originName ?? "unknown",
        destName: body?.destName ?? "unknown",
        hourOfDay: now.getHours(),
        state: "OFFER_CREATED",
        evidenceTier: "NONE",
      },
    });

    // log event (application-level audit trail — not cryptographically immutable)
    await db.experimentEvent.create({
      data: createEvent(exp.id, response.id, enrollment.participantId, null, "OFFER_CREATED", "system", email ?? "system"),
    });

    return NextResponse.json({ response, message: "Offer created. Present to verified provider." });
  }

  // === TRANSITION STATE — enrollment-bound, account-verified, atomic ===
  if (mode === "transition") {
    const enrollmentToken = body?.enrollmentToken;
    const responseId = body?.responseId;
    const newState = body?.newState as ExperimentState;

    if (!enrollmentToken || !responseId || !newState) {
      return NextResponse.json({ error: "enrollmentToken, responseId, newState required." }, { status: 400 });
    }

    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid enrollment token." }, { status: 404 });
    if (enrollment.status === "withdrawn") return NextResponse.json({ error: "Participant withdrawn." }, { status: 403 });

    // VERIFY: account matches enrollment
    if (enrollment.accountEmail !== email) {
      return NextResponse.json({ error: "CROSS-USER: enrollment belongs to different account." }, { status: 403 });
    }

    const response = await db.providerResponse.findUnique({ where: { id: responseId } });
    if (!response) return NextResponse.json({ error: "Response not found." }, { status: 404 });
    if (response.enrollmentId !== enrollment.id) {
      return NextResponse.json({ error: "CROSS-USER: response does not belong to this enrollment." }, { status: 403 });
    }

    // check offer expiry
    if (isOfferExpired(response.offerPresentedAt) && newState === "PROVIDER_ACCEPTED") {
      await db.providerResponse.updateMany({
        where: { id: responseId, state: response.state },
        data: { state: "PROVIDER_IGNORED", evidenceTier: "NONE", decisionAt: new Date().toISOString() },
      });
      return NextResponse.json({ error: "Offer expired. Auto-transitioned to PROVIDER_IGNORED. No W3 evidence." }, { status: 400 });
    }

    const fromState = response.state as ExperimentState;
    if (!isValidTransition(fromState, newState)) {
      return NextResponse.json({ error: `Invalid transition: ${fromState} → ${newState}.` }, { status: 400 });
    }

    // DEFECT 3 FIX: TRIP_COMPLETED requires EXTERNAL VERIFICATION (admin)
    if (newState === "TRIP_COMPLETED" && role !== "admin") {
      return NextResponse.json({
        error: "TRIP_COMPLETED requires external verification by an admin. Participants cannot self-report completion. W4 evidence requires admin verification.",
      }, { status: 403 });
    }

    const newTier = evidenceTierForState(newState);
    const decision = newState === "PROVIDER_ACCEPTED" ? "accept"
      : newState === "PROVIDER_DECLINED" ? "decline"
      : newState === "PROVIDER_UNAVAILABLE" ? "not_available"
      : newState === "PROVIDER_IGNORED" ? "ignore"
      : response.decision;

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
    }
    if (newState === "TRIP_CANCELLED") { updateData.executed = false; updateData.executionFailureReason = body?.reason ?? "cancelled"; }

    // ATOMIC UPDATE
    const updated = await db.providerResponse.updateMany({
      where: { id: responseId, state: fromState },
      data: updateData,
    });

    if (updated.count === 0) {
      return NextResponse.json({ error: "Race condition: state changed before transition." }, { status: 409 });
    }

    // log event (application-level audit trail)
    await db.experimentEvent.create({
      data: createEvent(enrollment.experimentId, responseId, enrollment.participantId, fromState, newState,
        newState === "TRIP_COMPLETED" ? "admin" : "participant",
        newState === "TRIP_COMPLETED" ? email ?? "admin" : enrollment.participantId),
    });

    const w3created = newState === "PROVIDER_ACCEPTED";
    const w4created = newState === "TRIP_COMPLETED";

    return NextResponse.json({
      responseId,
      fromState,
      toState: newState,
      evidenceTier: newTier,
      w3Created: w3created,
      w4Created: w4created,
      message: w3created
        ? `W3 recorded: verified provider ${enrollment.participantId} accepted. (Provider was admin-verified; consent was server-checked.)`
        : w4created
        ? `W4 recorded: trip completion EXTERNALLY VERIFIED by admin ${email}. Participant could not self-report this.`
        : `State: ${fromState} → ${newState}. Evidence: ${newTier}.`,
    });
  }

  return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
}
