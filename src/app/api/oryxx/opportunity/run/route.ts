// ORYXX — Real-world opportunity experiment endpoint.
// POST /api/oryxx/opportunity/run
//   body: Partial<RealExperimentConfig> + { useRealOsm?, survivalGrid? }
// Runs the opportunity experiment on real OSM data (with fixture fallback for
// transit/movement) and returns the full result including survival analysis.
// Auth-required, rate-limited.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { runOpportunityExperiment } from "@/lib/oryxx/real/engine/runner";
import { OsmAccraProvider } from "@/lib/oryxx/real/providers/osm-accra";
import type { RealExperimentConfig } from "@/lib/oryxx/real/types";

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

function clamp(n: any, min: number, max: number): number {
  const v = Number(n);
  if (!isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

// Cache the OSM provider so real road data is fetched once per process
let osmProvider: OsmAccraProvider | null = null;
let osmLoaded = false;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as any)?.email;
  if (!email) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (rateLimited(email)) {
    return NextResponse.json({ error: "Rate limit: max 6 experiments per minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const config: RealExperimentConfig = {
    seed: clamp(body?.seed ?? 42, 1, 999999),
    numDemands: clamp(body?.numDemands ?? 200, 10, 2000),
    movementDensity: Number(body?.movementDensity ?? 1.0) || 1.0,
    planningHorizonSec: clamp(body?.planningHorizonSec ?? 0, 0, 7 * 86400),
    willingness: Math.max(0, Math.min(1, Number(body?.willingness ?? 0.5))),
    detourToleranceKm: Math.max(0, Math.min(10, Number(body?.detourToleranceKm ?? 2.0))),
    hourFilter: body?.hourFilter == null ? null : clamp(body.hourFilter, 0, 23),
  };

  const useRealOsm = body?.useRealOsm !== false; // default: use real OSM
  const survivalGrid = body?.survivalGrid ?? "conservative";

  // Pre-fetch real OSM data so the sync runner can use it
  if (useRealOsm && !osmLoaded) {
    osmProvider = new OsmAccraProvider(config.seed, config.movementDensity);
    try {
      await osmProvider.ensureLoaded();
      osmLoaded = true;
    } catch (e) {
      console.error("[opportunity/run] OSM fetch failed, will use fixture:", e);
      osmLoaded = true; // mark loaded so we don't retry; runner will use fixture fallback
    }
  }

  try {
    const result = runOpportunityExperiment(config, { useRealOsm, survivalGrid });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[oryxx/opportunity/run]", err);
    return NextResponse.json({ error: "Experiment failed.", detail: (err as Error)?.message }, { status: 500 });
  }
}
