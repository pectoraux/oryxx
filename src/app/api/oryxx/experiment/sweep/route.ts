// ORYXX — Sweep endpoint (sensitivity analysis).
// POST /api/oryxx/experiment/sweep
//   body: { experiment: "planning-horizon"|"npd-density"|"demand-density"|"supply-ratio",
//           values: number[], numSeedsPerPoint: number, baseConfig?: Partial<ExperimentConfig> }
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { runSweep } from "@/lib/oryxx/market/experiment/runner";
import { REGIMES, regimeToConfig } from "@/lib/oryxx/market/experiment/regimes";
import type { ExperimentConfig } from "@/lib/oryxx/market/canonical/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const rateMap = new Map<string, number[]>();
function rateLimited(email: string): boolean {
  const now = Date.now();
  const arr = (rateMap.get(email) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 3) return true;
  arr.push(now);
  rateMap.set(email, arr);
  return false;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as any)?.email;
  if (!email) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (rateLimited(email)) {
    return NextResponse.json({ error: "Rate limit: max 3 sweeps per minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const experiment = body?.experiment;
  if (!["planning-horizon", "npd-density", "demand-density", "supply-ratio"].includes(experiment)) {
    return NextResponse.json({ error: "Invalid experiment type." }, { status: 400 });
  }
  const values: number[] = Array.isArray(body?.values) ? body.values.filter((v: any) => isFinite(Number(v))).map(Number) : [];
  if (values.length === 0) return NextResponse.json({ error: "Provide values array." }, { status: 400 });
  if (values.length > 8) return NextResponse.json({ error: "Max 8 sweep points." }, { status: 400 });
  const numSeedsPerPoint = Math.max(1, Math.min(20, Number(body?.numSeedsPerPoint ?? 5)));

  const regimeId = body?.regue ?? body?.regime ?? "balanced";
  const regime = REGIMES.find((r) => r.id === regimeId) ?? REGIMES.find((r) => r.id === "balanced")!;
  const baseConfig: ExperimentConfig = regimeToConfig(regime, 42, numSeedsPerPoint);
  // cap demands for sweeps to keep total compute bounded
  baseConfig.numDemands = Math.min(baseConfig.numDemands, 200);
  baseConfig.exactMaxDemands = 0; // no exact in sweeps
  if (experiment === "demand-density") {
    // values override numDemands; keep others as regime
  }
  if (body?.baseConfig) {
    Object.assign(baseConfig, body.baseConfig);
  }

  try {
    const result = runSweep(baseConfig, experiment, values, numSeedsPerPoint);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[oryxx/experiment/sweep]", err);
    return NextResponse.json({ error: "Sweep failed.", detail: (err as Error)?.message }, { status: 500 });
  }
}
