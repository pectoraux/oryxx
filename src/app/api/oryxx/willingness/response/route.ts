// ORYXX — Field experiment: submit a provider response.
// POST records a real provider's accept/decline decision (W3 evidence).
// Auth required but any logged-in user can be a "provider" in the experiment.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import { randomBytes } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const experimentId = body?.experimentId;
  if (!experimentId) return NextResponse.json({ error: "experimentId required." }, { status: 400 });

  const exp = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
  if (!exp) return NextResponse.json({ error: "Experiment not found." }, { status: 404 });
  if (exp.status !== "active") return NextResponse.json({ error: `Experiment status is '${exp.status}', not 'active'.` }, { status: 400 });

  // generate pseudonymous provider ID (no PII)
  const providerId = body?.providerId ?? `P-${randomBytes(6).toString("hex")}`;

  const decision = body?.decision;
  if (!["accept", "decline", "not_available", "not_eligible", "ignore"].includes(decision)) {
    return NextResponse.json({ error: "Invalid decision." }, { status: 400 });
  }

  // safety constraints
  const detourKm = Number(body?.detourKm ?? 0);
  const compensation = Number(body?.compensation ?? 0);
  if (detourKm > exp.maxDetourKm) return NextResponse.json({ error: `Detour ${detourKm}km exceeds max ${exp.maxDetourKm}km.` }, { status: 400 });
  if (compensation < exp.minCompensation) return NextResponse.json({ error: `Compensation $${compensation} below min $${exp.minCompensation}.` }, { status: 400 });

  const evidenceTier = decision === "accept" ? "W3" : "W2a";
  const executed = decision === "accept" ? (body?.executed ?? null) : null;
  const completed = executed === true ? (body?.completed ?? null) : null;

  const response = await db.providerResponse.create({
    data: {
      experimentId,
      providerId,
      compensation,
      detourKm,
      extraTimeMin: Number(body?.extraTimeMin ?? 0),
      advanceNoticeMin: Number(body?.advanceNoticeMin ?? 0),
      passengerCount: Number(body?.passengerCount ?? 1),
      tripDistanceKm: Number(body?.tripDistanceKm ?? 0),
      originName: String(body?.originName ?? "unknown"),
      destName: String(body?.destName ?? "unknown"),
      hourOfDay: Number(body?.hourOfDay ?? 12),
      decision,
      executed,
      completed,
      executionFailureReason: body?.executionFailureReason ?? null,
      evidenceTier,
      consentObtained: true, // UI must show consent before this endpoint
    },
  });

  return NextResponse.json({
    response,
    evidenceTier,
    message: decision === "accept"
      ? `W3 evidence recorded: provider ${providerId} ACCEPTED. ${completed === true ? "W4: trip COMPLETED." : completed === false ? "Execution tracked but not completed." : "Execution pending."}`
      : `Response recorded: ${decision}. No W3 evidence from this response.`,
  });
}
