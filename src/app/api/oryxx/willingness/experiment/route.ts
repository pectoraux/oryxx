// ORYXX — Field experiment: create + list experiments.
// POST creates a new acceptance experiment (admin only).
// GET lists experiments + their W3/W4 response counts.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const experiments = await db.acceptanceExperiment.findMany({
    include: { _count: { select: { responses: true } } },
    orderBy: { createdAt: "desc" },
  });

  // for each experiment, count acceptances + completions
  const results = await Promise.all(experiments.map(async (exp) => {
    const responses = await db.providerResponse.findMany({
      where: { experimentId: exp.id },
      select: { decision: true, executed: true, completed: true },
    });
    const accepted = responses.filter((r) => r.decision === "accept").length;
    const completed = responses.filter((r) => r.completed === true).length;
    return {
      ...exp,
      totalResponses: responses.length,
      accepted,
      completed,
      acceptanceRate: responses.length > 0 ? Math.round((accepted / responses.length) * 1000) / 10 : null,
      completionRate: accepted > 0 ? Math.round((completed / accepted) * 1000) / 10 : null,
      // W3 evidence exists iff accepted > 0
      hasW3Evidence: accepted > 0,
      hasW4Evidence: completed > 0,
    };
  }));

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
      name: body?.name ?? "Acceptance Field Experiment",
      description: body?.description ?? "Measures real provider acceptance of pooled-trip offers (W3/W4 evidence).",
      status: "designed",
      maxDetourKm: body?.maxDetourKm ?? 5.0,
      minCompensation: body?.minCompensation ?? 1.0,
      requiresConsent: true,
      consentText: "You are participating in a research study about transportation provider willingness to accept additional passengers. Your responses will be recorded pseudonymously. You may withdraw at any time. No personal identifying information will be stored.",
    },
  });

  return NextResponse.json({ experiment: exp, message: "Experiment created. Status: designed. No W3 data yet — deploy to providers to collect responses." });
}
