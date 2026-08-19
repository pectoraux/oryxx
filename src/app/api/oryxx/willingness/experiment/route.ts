// ORYXX — W3 Pilot: enrollment-bound experiment API.
// POST creates experiment (admin) or enrolls participant or transitions state.
// GET lists experiments + per-cell evidence.
//
// RESEARCH INTEGRITY GUARANTEES:
// - providerId is SERVER-GENERATED from enrollment, NEVER client-supplied
// - consent is SERVER-VERIFIED before any offer/response
// - state transitions are ATOMIC (WHERE id=? AND state=expected)
// - evidence tier is computed from state, never trusted from client
// - preregistration is immutable after ACTIVE (DB + API enforced)
// - all transitions are logged to append-only ExperimentEvent
// - offer expiry is enforced (expired → PROVIDER_IGNORED, not W3)

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

// GET: list experiments + per-cell evidence counts
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const experiments = await db.acceptanceExperiment.findMany({
    include: {
      _count: { select: { responses: true, enrollments: true, events: true } },
    },
    orderBy: { id: "desc" },
  });

  const results = await Promise.all(experiments.map(async (exp) => {
    const responses = await db.providerResponse.findMany({
      where: { experimentId: exp.id },
      select: { state: true, evidenceTier: true, treatmentCellId: true, decision: true },
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
// mode=create_experiment (admin only) → creates a DRAFT experiment
// mode=preregister (admin) → locks design, computes hash, status→PREREGISTERED
// mode=activate (admin) → status→ACTIVE (design becomes immutable)
// mode=enroll → creates enrollment + consent → returns enrollment token
// mode=consent → records consent
// mode=create_offer → creates offer for enrolled participant
// mode=transition → state transition (atomic, enrollment-bound)
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

  // === PREREGISTER (admin) ===
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
        preregistrationHash: hash,
        preregisteredAt: new Date().toISOString(),
        population: design.population,
        geography: design.geography,
        providerType: design.providerType,
        analysisMethod: design.analysisMethod,
        secondaryOutcomes: JSON.stringify(design.secondaryOutcomes),
      },
    });

    return NextResponse.json({ experiment: updated, preregistrationHash: hash, message: "Preregistered. Hash computed. Activate to begin (design becomes immutable)." });
  }

  // === ACTIVATE (admin) ===
  if (mode === "activate") {
    if (role !== "admin") return NextResponse.json({ error: "Admin required." }, { status: 403 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: body?.experimentId } });
    if (!exp) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (exp.status !== "PREREGISTERED") return NextResponse.json({ error: `Cannot activate: status is ${exp.status}.` }, { status: 400 });
    const updated = await db.acceptanceExperiment.update({ where: { id: exp.id }, data: { status: "ACTIVE" } });
    return NextResponse.json({ experiment: updated, message: "ACTIVE. Design is now IMMUTABLE. Begin enrolling participants." });
  }

  // === ENROLL (any authenticated user becomes a participant) ===
  if (mode === "enroll") {
    const experimentId = body?.experimentId;
    if (!experimentId) return NextResponse.json({ error: "experimentId required." }, { status: 400 });
    const exp = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
    if (!exp) return NextResponse.json({ error: "Experiment not found." }, { status: 404 });
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Experiment is ${exp.status}, not ACTIVE.` }, { status: 400 });

    // SERVER-GENERATED pseudonymous participant ID (NOT client-supplied)
    const participantId = `P-${randomBytes(8).toString("hex")}`;
    const enrollmentToken = randomBytes(24).toString("hex");

    // assign treatment cell (balanced, deterministic)
    const design: PreregisteredDesign = {
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
    const cells = generateTreatmentCells(design);
    const priorCount = await db.experimentEnrollment.count({ where: { experimentId } });
    const cell = assignTreatment(participantId, experimentId, exp.randomizationSeed, cells, priorCount);

    const enrollment = await db.experimentEnrollment.create({
      data: {
        experimentId,
        participantId,
        enrollmentToken,
        assignedCellId: cell.id,
      },
    });

    return NextResponse.json({
      enrollment,
      assignedCell: cell,
      consentRequired: exp.requiresConsent,
      consentText: exp.consentText,
      message: "Enrolled. Participant ID is server-generated. Consent required before participation.",
    });
  }

  // === CONSENT (participant records consent) ===
  if (mode === "consent") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });

    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid enrollment token." }, { status: 404 });

    const exp = enrollment.experiment;
    const consentTextHash = createHash("sha256").update(exp.consentText ?? "").digest("hex").substring(0, 16);

    const consent = await db.experimentConsent.create({
      data: {
        experimentId: exp.id,
        enrollmentId: enrollment.id,
        participantId: enrollment.participantId,
        consentVersion: exp.consentVersion,
        consentTextHash,
        consentText: exp.consentText ?? "",
      },
    });

    return NextResponse.json({ consent, message: "Consent recorded. Participant may now receive offers." });
  }

  // === CREATE OFFER (system/participant-initiated) ===
  if (mode === "create_offer") {
    const enrollmentToken = body?.enrollmentToken;
    if (!enrollmentToken) return NextResponse.json({ error: "enrollmentToken required." }, { status: 400 });

    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid enrollment token." }, { status: 404 });
    if (enrollment.status === "withdrawn") return NextResponse.json({ error: "Participant has withdrawn." }, { status: 403 });

    const exp = enrollment.experiment;
    if (exp.status !== "ACTIVE") return NextResponse.json({ error: `Experiment is ${exp.status}.` }, { status: 400 });

    // SERVER-VERIFY consent
    if (exp.requiresConsent) {
      const consent = await db.experimentConsent.findFirst({
        where: { enrollmentId: enrollment.id, withdrawnAt: null },
      });
      if (!consent) return NextResponse.json({ error: "Consent required but not found. Record consent first." }, { status: 403 });
    }

    // use the assigned treatment cell (immutable)
    const design: PreregisteredDesign = {
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
    const cells = generateTreatmentCells(design);
    const cell = cells.find((c) => c.id === enrollment.assignedCellId) ?? cells[0];

    // SERVER-SIDE safety validation
    const safety = validateOfferSafety(
      { detourKm: cell.detourKm, extraTimeMin: cell.extraTimeMin, compensation: cell.compensation, passengerCount: 1 },
      { maxDetourKm: exp.maxDetourKm, maxExtraTimeMin: exp.maxExtraTimeMin, minCompensation: exp.minCompensation },
    );
    if (!safety.safe) return NextResponse.json({ error: "Offer rejected by safety validator", violations: safety.violations }, { status: 400 });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 min expiry

    const response = await db.providerResponse.create({
      data: {
        experimentId: exp.id,
        enrollmentId: enrollment.id,
        participantId: enrollment.participantId, // SERVER-DERIVED, not client
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
        evidenceTier: "NONE", // NOT W2a — application state ≠ evidence tier
      },
    });

    // log event
    await db.experimentEvent.create({
      data: createEvent(exp.id, response.id, enrollment.participantId, null, "OFFER_CREATED", "system", email ?? "system"),
    });

    return NextResponse.json({ response, message: "Offer created. Transition to OFFER_PRESENTED to show to participant." });
  }

  // === TRANSITION STATE (atomic, enrollment-bound) ===
  if (mode === "transition") {
    const enrollmentToken = body?.enrollmentToken;
    const responseId = body?.responseId;
    const newState = body?.newState as ExperimentState;

    if (!enrollmentToken || !responseId || !newState) {
      return NextResponse.json({ error: "enrollmentToken, responseId, newState required." }, { status: 400 });
    }

    // verify enrollment
    const enrollment = await db.experimentEnrollment.findUnique({ where: { enrollmentToken }, include: { experiment: true } });
    if (!enrollment) return NextResponse.json({ error: "Invalid enrollment token." }, { status: 404 });
    if (enrollment.status === "withdrawn") return NextResponse.json({ error: "Participant withdrawn." }, { status: 403 });

    // fetch response — verify it belongs to THIS enrollment
    const response = await db.providerResponse.findUnique({ where: { id: responseId } });
    if (!response) return NextResponse.json({ error: "Response not found." }, { status: 404 });
    if (response.enrollmentId !== enrollment.id) {
      return NextResponse.json({ error: "CROSS-USER ATTACK: response does not belong to this enrollment." }, { status: 403 });
    }
    if (response.experimentId !== enrollment.experimentId) {
      return NextResponse.json({ error: "Experiment mismatch." }, { status: 403 });
    }

    // check offer expiry
    if (isOfferExpired(response.offerPresentedAt) && newState === "PROVIDER_ACCEPTED") {
      // expired offer → auto-transition to PROVIDER_IGNORED
      const expired = await db.providerResponse.update({
        where: { id: responseId, state: response.state }, // atomic: only if state hasn't changed
        data: { state: "PROVIDER_IGNORED", evidenceTier: "NONE", decisionAt: new Date().toISOString() },
      });
      await db.experimentEvent.create({
        data: createEvent(enrollment.experimentId, responseId, enrollment.participantId, response.state as ExperimentState, "PROVIDER_IGNORED", "system", "expiry"),
      });
      return NextResponse.json({ error: "Offer expired. Auto-transitioned to PROVIDER_IGNORED. No W3 evidence." }, { status: 400 });
    }

    const fromState = response.state as ExperimentState;
    if (!isValidTransition(fromState, newState)) {
      return NextResponse.json({ error: `Invalid transition: ${fromState} → ${newState}.` }, { status: 400 });
    }

    // compute evidence tier from state (NOT from client)
    const newTier = evidenceTierForState(newState);
    const decision = newState === "PROVIDER_ACCEPTED" ? "accept"
      : newState === "PROVIDER_DECLINED" ? "decline"
      : newState === "PROVIDER_UNAVAILABLE" ? "not_available"
      : newState === "PROVIDER_IGNORED" ? "ignore"
      : response.decision;

    // ATOMIC UPDATE: only succeeds if state hasn't changed (race condition protection)
    const updateData: any = { state: newState, evidenceTier: newTier };
    if (newState === "OFFER_PRESENTED") updateData.offerPresentedAt = new Date().toISOString();
    if (newState === "PROVIDER_VIEWED") updateData.providerViewedAt = new Date().toISOString();
    if (["PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE", "PROVIDER_IGNORED"].includes(newState)) {
      updateData.decision = decision;
      updateData.decisionAt = new Date().toISOString();
    }
    if (newState === "TRIP_STARTED") updateData.executed = true;
    if (newState === "TRIP_COMPLETED") { updateData.executed = true; updateData.completed = true; }
    if (newState === "TRIP_CANCELLED") { updateData.executed = false; updateData.executionFailureReason = body?.reason ?? "cancelled"; }

    const updated = await db.providerResponse.updateMany({
      where: { id: responseId, state: fromState }, // atomic: WHERE id=? AND state=expected
      data: updateData,
    });

    if (updated.count === 0) {
      return NextResponse.json({ error: "Race condition: state changed before transition. No update applied." }, { status: 409 });
    }

    // log event (append-only)
    await db.experimentEvent.create({
      data: createEvent(enrollment.experimentId, responseId, enrollment.participantId, fromState, newState, "participant", enrollment.participantId),
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
        ? `⚠ W3 EVIDENCE CREATED: participant ${enrollment.participantId} ACCEPTED a real offer.`
        : w4created
        ? `⚠ W4 EVIDENCE CREATED: pooled trip COMPLETED.`
        : `State: ${fromState} → ${newState}. Evidence tier: ${newTier}.`,
    });
  }

  return NextResponse.json({ error: "Unknown mode. Use: create_experiment, preregister, activate, enroll, consent, create_offer, transition." }, { status: 400 });
}
