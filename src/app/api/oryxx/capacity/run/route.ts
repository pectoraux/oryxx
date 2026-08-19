// ORYXX — Capacity evidence experiment endpoint.
// POST /api/oryxx/capacity/run
//   body: Partial<CapacityExperimentConfig>
// Runs the capacity evidence experiment on real NYC taxi data with observed
// passenger_count. Separates observed movement, observed capacity, and assumed
// willingness into evidence tiers.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { runCapacityExperiment } from "@/lib/oryxx/real/evidence/engine";
import type { CapacityExperimentConfig } from "@/lib/oryxx/real/evidence/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const rateMap = new Map<string, number[]>();
function rateLimited(email: string): boolean {
  const now = Date.now();
  const arr = (rateMap.get(email) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 6) return true;
  arr.push(now);
  rateMap.set(email, arr);
  return false;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as any)?.email;
  if (!email) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (rateLimited(email)) {
    return NextResponse.json({ error: "Rate limit: max 6 experiments per minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const config: CapacityExperimentConfig = {
    seed: Number(body?.seed ?? 42) || 42,
    numDemands: Math.max(10, Math.min(1000, Number(body?.numDemands ?? 150))),
    detourToleranceKm: Math.max(0.5, Math.min(10, Number(body?.detourToleranceKm ?? 3.0))),
    minCompensation: Math.max(0, Number(body?.minCompensation ?? 3.0)),
    willingness: Math.max(0.05, Math.min(1, Number(body?.willingness ?? 0.15))),
    executionProbability: Math.max(0.1, Math.min(1, Number(body?.executionProbability ?? 0.45))),
    pilot: "nyc-taxi",
  };

  try {
    const result = runCapacityExperiment(config);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[oryxx/capacity/run]", err);
    return NextResponse.json({ error: "Experiment failed.", detail: (err as Error)?.message }, { status: 500 });
  }
}
