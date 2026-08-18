// ORYXX — Experiment endpoint.
// POST /api/oryxx/experiment/run
//   body: { config: Partial<ExperimentConfig>, regime?: string, numSeeds?: number }
// Runs a multi-seed experiment and returns statistics + paired diffs + failure cases.
// Auth-required, rate-limited, size-capped.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { runExperiment } from "@/lib/oryxx/market/experiment/runner";
import { REGIMES, regimeToConfig } from "@/lib/oryxx/market/experiment/regimes";
import { DEFAULT_WORLD } from "@/lib/oryxx/market/canonical/types";
import type { ExperimentConfig, StrategyId } from "@/lib/oryxx/market/canonical/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const rateMap = new Map<string, number[]>();
const RATE_LIMIT = 6; // per 60s — experiments are expensive
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
      { error: "Rate limit: max 6 experiments per minute." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const regimeId = body?.regue ?? body?.regime;
  const regime = REGIMES.find((r) => r.id === regimeId) ?? REGIMES.find((r) => r.id === "balanced")!;
  const numSeeds = clamp(body?.numSeeds ?? body?.config?.numSeeds, 1, 100);
  const config: ExperimentConfig = regimeToConfig(regime, clamp(body?.seed ?? 42, 1, 999999), numSeeds);
  // allow overrides
  if (body?.config?.numDemands) config.numDemands = clamp(body.config.numDemands, 10, 2000);
  if (body?.config?.numDrivers) config.numDrivers = clamp(body.config.numDrivers, 0, 500);
  if (body?.config?.numNPDs) config.numNPDs = clamp(body.config.numNPDs, 0, 200);
  if (body?.config?.numTrucks) config.numTrucks = clamp(body.config.numTrucks, 0, 200);
  if (body?.config?.numTransitLines) config.numTransitLines = clamp(body.config.numTransitLines, 0, 20);
  if (body?.config?.regionKm) config.regionKm = clamp(body.config.regionKm, 5, 100);
  // world overrides
  if (body?.world) {
    config.world = { ...config.world, ...body.world };
  }
  // strategy subset
  if (Array.isArray(body?.strategies) && body.strategies.length > 0) {
    config.strategies = body.strategies.filter((s: string) =>
      ["ordinary", "centralized", "oryxx", "clairvoyant"].includes(s),
    ) as StrategyId[];
    if (config.strategies.length === 0) config.strategies = ["ordinary", "centralized", "oryxx", "clairvoyant"];
  }
  // exact solver cap (lower it if numSeeds is high to keep response time bounded)
  config.exactMaxDemands = config.numDemands <= 16 ? 16 : 0; // disable exact for large instances

  try {
    const result = runExperiment(config);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[oryxx/experiment/run]", err);
    return NextResponse.json(
      { error: "Experiment failed.", detail: (err as Error)?.message },
      { status: 500 },
    );
  }
}
