// ORYXX — W3 Pilot: create experiment with preregistration.
// POST creates a preregistered experiment (admin only).
// GET lists experiments + W3/W4 evidence counts.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import { evidenceTierForState, emptyEvidenceCounts, wilsonCI } from "@/lib/oryxx/real/evidence/pilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const experiments = await db.acceptanceExperiment.findMany({
    include: { responses: true },
    orderBy: { id: "desc" },
  });

  const results = experiments.map((exp) => {
    const responses = exp.responses;
    const counts = emptyEvidenceCounts();
    counts.totalResponses = responses.length;
    counts.offersPresented = responses.filter((r) => r.state !== "OFFER_CREATED").length;
    counts.offersViewed = responses.filter((r) => ["PROVIDER_VIEWED", "PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE"].includes(r.state)).length;
    counts.accepted = responses.filter((r) => r.state === "PROVIDER_ACCEPTED" || r.state === "TRIP_STARTED" || r.state === "TRIP_COMPLETED" || r.state === "TRIP_CANCELLED").length;
    counts.declined = responses.filter((r) => r.state === "PROVIDER_DECLINED").length;
    counts.unavailable = responses.filter((r) => r.state === "PROVIDER_UNAVAILABLE").length;
    counts.ignored = responses.filter((r) => r.state === "PROVIDER_IGNORED").length;
    counts.tripStarted = responses.filter((r) => r.state === "TRIP_STARTED" || r.state === "TRIP_COMPLETED").length;
    counts.tripCompleted = responses.filter((r) => r.state === "TRIP_COMPLETED").length;
    counts.tripCancelled = responses.filter((r) => r.state === "TRIP_CANCELLED").length;
    // W3/W4 counts (only from explicit state transitions)
    counts.w3 = counts.accepted;
    counts.w4 = counts.tripCompleted;
    if (counts.offersViewed > 0) {
      counts.acceptanceRate = Math.round((counts.accepted / counts.offersViewed) * 1000) / 1000;
      counts.acceptanceCI95 = wilsonCI(counts.accepted, counts.offersViewed);
    }
    if (counts.accepted > 0) {
      counts.completionRate = Math.round((counts.tripCompleted / counts.accepted) * 1000) / 1000;
      counts.completionCI95 = wilsonCI(counts.tripCompleted, counts.accepted);
    }
    return {
      ...exp,
      evidence: counts,
      hasW3Evidence: counts.w3 > 0,
      hasW4Evidence: counts.w4 > 0,
    };
  });

  return NextResponse.json({ experiments: results });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any)?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const exp = await db.acceptanceExperiment.create({
    data: {
      name: body?.name ?? "W3 Acceptance Pilot",
      description: body?.description ?? "Preregistered field experiment measuring real provider acceptance of pooled-trip offers.",
      status: "preregistered",
      maxDetourKm: body?.maxDetourKm ?? 5.0,
      maxExtraTimeMin: body?.maxExtraTimeMin ?? 20.0,
      minCompensation: body?.minCompensation ?? 1.0,
      requiresConsent: true,
      consentText: "You are participating in a research study about transportation provider willingness to accept additional passengers. Your responses will be recorded pseudonymously. You may withdraw at any time. No personal identifying information will be stored.",
      hypothesis: body?.hypothesis ?? "Transportation providers will accept pooled-trip offers at rates sufficient for marketplace viability when compensation ≥ $3 and detour ≤ 2km.",
      sampleTarget: body?.sampleTarget ?? 100,
      primaryOutcome: "W3_acceptance_rate",
      stoppingRule: body?.stoppingRule ?? "Stop after 100 responses or 30 days, whichever comes first.",
      randomizationSeed: body?.randomizationSeed ?? 42,
      isImmutable: false,
      preregisteredAt: new Date().toISOString(),
    },
  });

  return NextResponse.json({
    experiment: exp,
    message: "Experiment PREREGISTERED. Status: preregistered (NOT active). No W3 data yet. Activate to begin collecting provider responses.",
  });
}
