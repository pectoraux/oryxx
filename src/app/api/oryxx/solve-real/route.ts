// ORYXX REAL solve endpoint (SLICE 1).
// POST /api/oryxx/solve-real
//   body: { intent?: string; event?: TransportationEvent }
//
// Same auth / rate-limit / body-cap posture as /api/oryxx/solve, but resolves
// the route against REAL external data:
//   - OSM Nominatim geocoding (REAL)
//   - OSRM road-network routing (REAL)
//   - Citi Bike observed supply near NYC (OBSERVED_ONLY)
//   - GTFS static schedule near a loaded feed (OBSERVED_ONLY)
//
// Distance + travel time are REAL. Cost / emissions / reliability / comfort
// are MODELLED (no live pricing API at HEAD) and clearly labelled as such in
// every plan's tradeoffNote and the response unknowns[].
//
// If geocoding fails for origin or destination, returns 200 with empty plans
// and a clear unknowns[] explanation — NEVER fabricates a synthetic route
// while claiming it is real.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { TransportationEvent } from "@/lib/oryxx/types";
import { parseIntent, heuristicParse } from "@/lib/oryxx/parse";
import { solveRealTransportationEvent } from "@/lib/oryxx/live/solver-real";
import { authOptions } from "@/lib/auth/options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

const RATE_LIMIT_MAX = 15; // tighter — real solver hits external APIs
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function rateLimitCheck(email: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateBuckets.get(email) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_LIMIT_MAX) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    rateBuckets.set(email, recent);
    return { ok: false, retryAfterSec };
  }
  recent.push(now);
  rateBuckets.set(email, recent);
  return { ok: true, retryAfterSec: 0 };
}

const MAX_INTENT_CHARS = 2000;
const MAX_EVENT_CHARS = 8000;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as any)?.email as string | undefined;
  if (!email) return bad("Authentication required.", 401);

  const rl = rateLimitCheck(email);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return bad("Invalid JSON body.");
  }

  if (typeof body?.intent === "string" && body.intent.length > MAX_INTENT_CHARS) {
    return bad(`Intent too long (max ${MAX_INTENT_CHARS} chars).`, 413);
  }
  if (body?.event != null) {
    let eventJsonLen: number;
    try {
      eventJsonLen = JSON.stringify(body.event).length;
    } catch {
      eventJsonLen = Infinity;
    }
    if (eventJsonLen > MAX_EVENT_CHARS) {
      return bad(`Event payload too large (max ${MAX_EVENT_CHARS} chars).`, 413);
    }
  }

  let event: TransportationEvent;
  let parsedBy: "llm" | "heuristic" | "structured" = "structured";

  try {
    if (body?.event && body.event.origin && body.event.destination) {
      event = normalizeEvent(body.event as TransportationEvent);
      parsedBy = "structured";
    } else if (typeof body?.intent === "string" && body.intent.trim()) {
      const parsed = await parseIntent(body.intent);
      event = parsed.event;
      parsedBy = parsed.parsedBy;
    } else {
      return bad("Provide either `intent` (string) or `event` (TransportationEvent).");
    }

    if (!event.origin || !event.destination) {
      return bad("Could not determine origin and destination from the intent.");
    }

    const result = await solveRealTransportationEvent(event, parsedBy);

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[oryxx/solve-real] error:", err);
    return NextResponse.json(
      { error: "Real solver failure", detail: (err as Error)?.message ?? String(err) },
      { status: 502 },
    );
  }
}

function normalizeEvent(e: TransportationEvent): TransportationEvent {
  const fallback = heuristicParse(e.rawIntent ?? `${e.origin} to ${e.destination}`);
  return {
    object: e.object ?? fallback.object,
    origin: e.origin,
    destination: e.destination,
    earliestDeparture: e.earliestDeparture ?? fallback.earliestDeparture,
    preferredDeparture: e.preferredDeparture ?? fallback.preferredDeparture,
    latestArrival: e.latestArrival ?? fallback.latestArrival,
    constraints: { ...fallback.constraints, ...(e.constraints ?? {}) },
    objectives: { ...fallback.objectives, ...(e.objectives ?? {}) },
    riskTolerance: e.riskTolerance ?? fallback.riskTolerance,
    autonomy: e.autonomy ?? fallback.autonomy,
    rawIntent: e.rawIntent,
  };
}
