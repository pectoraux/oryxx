// ORYXX — W3 Pilot: submit/transition provider response with state machine.
// POST creates an offer OR transitions an existing offer's state.
// Only PROVIDER_ACCEPTED creates W3. Only TRIP_COMPLETED creates W4.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import { isValidTransition, evidenceTierForState, validateOfferSafety, assignTreatment } from "@/lib/oryxx/real/evidence/pilot";
import { randomBytes } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const experimentId = body?.experimentId;
  if (!experimentId) return NextResponse.json({ error: "experimentId required." }, { status: 400 });

  const exp = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
  if (!exp) return NextResponse.json({ error: "Experiment not found." }, { status: 404 });
  if (exp.status !== "active") return NextResponse.json({ error: `Experiment status is '${exp.status}'. Must be 'active' to collect responses.` }, { status: 400 });

  const providerId = body?.providerId ?? `P-${randomBytes(6).toString("hex")}`;

  // Mode 1: create a new offer (OFFER_CREATED)
  if (body?.mode === "create_offer") {
    // deterministic treatment assignment
    const cells = [
      { compensation: body?.compensation ?? 3, detourKm: body?.detourKm ?? 2, extraTimeMin: body?.extraTimeMin ?? 5, advanceNoticeMin: body?.advanceNoticeMin ?? 0 },
    ];
    const cell = assignTreatment(providerId, experimentId, exp.randomizationSeed, cells);

    // safety check
    const safety = validateOfferSafety(cell, { maxDetourKm: exp.maxDetourKm, maxExtraTimeMin: exp.maxExtraTimeMin, minCompensation: exp.minCompensation });
    if (!safety.safe) return NextResponse.json({ error: "Offer rejected by safety validator", violations: safety.violations }, { status: 400 });

    const response = await db.providerResponse.create({
      data: {
        experimentId,
        providerId,
        compensation: cell.compensation,
        detourKm: cell.detourKm,
        extraTimeMin: cell.extraTimeMin,
        advanceNoticeMin: cell.advanceNoticeMin,
        passengerCount: 1,
        tripDistanceKm: body?.tripDistanceKm ?? 5,
        originName: body?.originName ?? "unknown",
        destName: body?.destName ?? "unknown",
        hourOfDay: body?.hourOfDay ?? 17,
        state: "OFFER_CREATED",
        evidenceTier: "W0",
        consentObtained: body?.consentObtained ?? false,
      },
    });

    return NextResponse.json({ response, message: "Offer created (OFFER_CREATED). Present to provider to transition to OFFER_PRESENTED." });
  }

  // Mode 2: transition state
  const responseId = body?.responseId;
  const newState = body?.newState;
  if (!responseId || !newState) return NextResponse.json({ error: "Provide mode='create_offer' OR responseId + newState." }, { status: 400 });

  const existing = await db.providerResponse.findUnique({ where: { id: responseId } });
  if (!existing) return NextResponse.json({ error: "Response not found." }, { status: 404 });

  const fromState = existing.state as any;
  if (!isValidTransition(fromState, newState)) {
    return NextResponse.json({ error: `Invalid transition: ${fromState} → ${newState}. Valid transitions from ${fromState}: ${JSON.stringify((await import("@/lib/oryxx/real/evidence/pilot")).VALID_TRANSITIONS[fromState] ?? [])}` }, { status: 400 });
  }

  // compute new evidence tier
  const newTier = evidenceTierForState(newState);
  const decision = newState === "PROVIDER_ACCEPTED" ? "accept"
    : newState === "PROVIDER_DECLINED" ? "decline"
    : newState === "PROVIDER_UNAVAILABLE" ? "not_available"
    : newState === "PROVIDER_IGNORED" ? "ignore"
    : existing.decision;

  const updateData: any = {
    state: newState,
    evidenceTier: newTier,
    decision,
  };
  if (newState === "OFFER_PRESENTED") updateData.offerPresentedAt = new Date().toISOString();
  if (newState === "PROVIDER_VIEWED") updateData.providerViewedAt = new Date().toISOString();
  if (["PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE", "PROVIDER_IGNORED"].includes(newState)) {
    updateData.decisionAt = new Date().toISOString();
  }
  if (newState === "TRIP_STARTED") updateData.executed = true;
  if (newState === "TRIP_COMPLETED") { updateData.executed = true; updateData.completed = true; }
  if (newState === "TRIP_CANCELLED") { updateData.executed = false; updateData.executionFailureReason = body?.reason ?? "cancelled"; }

  const updated = await db.providerResponse.update({ where: { id: responseId }, data: updateData });

  const w3created = newState === "PROVIDER_ACCEPTED";
  const w4created = newState === "TRIP_COMPLETED";

  return NextResponse.json({
    response: updated,
    evidenceTier: newTier,
    w3Created: w3created,
    w4Created: w4created,
    message: w3created
      ? `⚠ W3 EVIDENCE CREATED: provider ${providerId} ACCEPTED a real offer.`
      : w4created
      ? `⚠ W4 EVIDENCE CREATED: pooled trip COMPLETED.`
      : `State transitioned: ${fromState} → ${newState}. Evidence tier: ${newTier}.`,
  });
}
