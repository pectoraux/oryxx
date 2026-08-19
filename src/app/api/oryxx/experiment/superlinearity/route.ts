// ORYXX — Superlinearity sweep endpoint.
// POST /api/oryxx/experiment/superlinearity
//   body: { dimension: "future-visibility"|"supply-density"|"demand-density"|"npd-density",
//           values: number[], numSeedsPerPoint: number, regime?: string }
// Tests whether ORYXX's advantage increases superlinearly with information density.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { runSuperlinearity } from "@/lib/oryxx/market/experiment/runner";
import { REGIMES, regimeToConfig } from "@/lib/oryxx/market/experiment/regimes";

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
    return NextResponse.json({ error: "Rate limit: max 3 superlinearity sweeps per minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const dimension = body?.dimension;
  const validDims = ["future-visibility", "supply-density", "demand-density", "npd-density"];
  if (!validDims.includes(dimension)) {
    return NextResponse.json({ error: "Invalid dimension." }, { status: 400 });
  }
  const values: number[] = Array.isArray(body?.values) ? body.values.filter((v: any) => isFinite(Number(v))).map(Number) : [];
  if (values.length < 4) return NextResponse.json({ error: "Need at least 4 values to fit a quadratic." }, { status: 400 });
  if (values.length > 10) return NextResponse.json({ error: "Max 10 sweep points." }, { status: 400 });
  const numSeedsPerPoint = Math.max(1, Math.min(15, Number(body?.numSeedsPerPoint ?? 5)));

  const regimeId = body?.regue ?? body?.regime ?? "balanced";
  const regime = REGIMES.find((r) => r.id === regimeId) ?? REGIMES.find((r) => r.id === "balanced")!;
  const baseConfig = regimeToConfig(regime, 42, numSeedsPerPoint);
  baseConfig.numDemands = Math.min(baseConfig.numDemands, 100);
  baseConfig.exactMaxDemands = 0;

  try {
    const result = runSuperlinearity(baseConfig, dimension as any, values, numSeedsPerPoint);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[oryxx/experiment/superlinearity]", err);
    return NextResponse.json({ error: "Sweep failed.", detail: (err as Error)?.message }, { status: 500 });
  }
}
