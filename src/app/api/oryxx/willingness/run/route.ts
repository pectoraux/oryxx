// ORYXX — Willingness evidence experiment endpoint.
// POST /api/oryxx/willingness/run
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { runWillingnessExperiment } from "@/lib/oryxx/real/evidence/willingness-engine";
import type { WillingnessExperimentConfig } from "@/lib/oryxx/real/evidence/willingness";

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
    return NextResponse.json({ error: "Rate limit." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const config: WillingnessExperimentConfig = {
    seed: Number(body?.seed ?? 42) || 42,
    numDemands: Math.max(50, Math.min(1000, Number(body?.numDemands ?? 150))),
    evidenceSource: "nyc-fhv-gaps",
    compensationLevels: body?.compensationLevels ?? [1, 2, 3, 4, 5, 7, 10],
    detourLevels: body?.detourLevels ?? [0, 0.5, 1, 2, 3, 5],
    noticeLevels: body?.noticeLevels ?? [0, 15, 60, 360, 1440],
  };

  try {
    const result = runWillingnessExperiment(config);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[oryxx/willingness/run]", err);
    return NextResponse.json({ error: "Experiment failed.", detail: (err as Error)?.message }, { status: 500 });
  }
}
