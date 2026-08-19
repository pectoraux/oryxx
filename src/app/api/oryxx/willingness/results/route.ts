// ORYXX — Field experiment: get W3/W4 results.
// GET returns acceptance rate, completion rate, CIs, and whether W3 evidence exists.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wilson score interval for 95% CI
function wilsonCI(accepts: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = accepts / total;
  const denom = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / denom;
  return {
    low: Math.round(Math.max(0, center - margin) * 1000) / 1000,
    high: Math.round(Math.min(1, center + margin) * 1000) / 1000,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const url = new URL(req.url);
  const experimentId = url.searchParams.get("experimentId");

  const responses = experimentId
    ? await db.providerResponse.findMany({ where: { experimentId } })
    : await db.providerResponse.findMany();

  const total = responses.length;
  const accepted = responses.filter((r) => r.decision === "accept").length;
  const completed = responses.filter((r) => r.completed === true).length;
  const declined = responses.filter((r) => r.decision === "decline").length;

  const acceptanceRate = total > 0 ? Math.round((accepted / total) * 1000) / 1000 : null;
  const completionRate = accepted > 0 ? Math.round((completed / accepted) * 1000) / 1000 : null;

  const acceptanceCI = total > 0 ? wilsonCI(accepted, total) : null;
  const completionCI = accepted > 0 ? wilsonCI(completed, accepted) : null;

  // acceptance by compensation level
  const byCompensation: Record<number, { offered: number; accepted: number }> = {};
  for (const r of responses) {
    const c = Math.round(r.compensation);
    if (!byCompensation[c]) byCompensation[c] = { offered: 0, accepted: 0 };
    byCompensation[c].offered++;
    if (r.decision === "accept") byCompensation[c].accepted++;
  }

  const byDetour: Record<number, { offered: number; accepted: number }> = {};
  for (const r of responses) {
    const d = Math.round(r.detourKm * 10) / 10;
    if (!byDetour[d]) byDetour[d] = { offered: 0, accepted: 0 };
    byDetour[d].offered++;
    if (r.decision === "accept") byDetour[d].accepted++;
  }

  return NextResponse.json({
    totalOffered: total,
    totalAccepted: accepted,
    totalDeclined: declined,
    totalCompleted: completed,
    acceptanceRate,
    completionRate,
    acceptanceCI95: acceptanceCI,
    completionCI95: completionCI,
    hasW3Evidence: accepted > 0,
    hasW4Evidence: completed > 0,
    evidenceTier: completed > 0 ? "W4" : accepted > 0 ? "W3" : "W0",
    byCompensation,
    byDetour,
    responses: responses.map((r) => ({ ...r, providerId: r.providerId.substring(0, 8) + "…" })), // truncate for display
  });
}
