// ORYXX — Market simulation endpoint.
// POST /api/oryxx/market/simulate
//   body: SimulationConfig (numbers, clamped to safe bounds)
// Requires an authenticated session. Size/rate-capped. Runs the deterministic
// market simulator and returns the full comparison result.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { runSimulation } from "@/lib/oryxx/market/simulate";
import type { SimulationConfig } from "@/lib/oryxx/market/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rateMap = new Map<string, number[]>();
const RATE_LIMIT = 10; // per 60s
const RATE_WINDOW = 60_000;

function rateLimited(email: string): boolean {
  const now = Date.now();
  const arr = (rateMap.get(email) ?? []).filter((t) => now - t < RATE_WINDOW);
  if (arr.length >= RATE_LIMIT) return true;
  arr.push(now);
  rateMap.set(email, arr);
  return false;
}

function clamp(n: any, min: number, max: number): number {
  const v = Number(n);
  if (!isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as any)?.email;
  if (!email) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (rateLimited(email)) {
    return NextResponse.json(
      { error: "Rate limit: max 10 simulations per minute." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const config: SimulationConfig = {
    seed: clamp(body?.seed, 1, 999999) || 42,
    numDemands: clamp(body?.numDemands, 10, 2000),
    numDrivers: clamp(body?.numDrivers, 0, 500),
    numNPDs: clamp(body?.numNPDs, 0, 200),
    numTrucks: clamp(body?.numTrucks, 0, 200),
    numTransitLines: clamp(body?.numTransitLines, 0, 20),
    regionKm: clamp(body?.regionKm, 5, 100),
  };

  try {
    const result = runSimulation(config);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[oryxx/market/simulate]", err);
    return NextResponse.json(
      { error: "Simulation failed.", detail: (err as Error)?.message },
      { status: 500 },
    );
  }
}
