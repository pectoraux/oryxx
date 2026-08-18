// ORYXX solve endpoint.
// POST /api/oryxx/solve
//   body: { intent?: string; event?: TransportationEvent }
// The LLM parses intent -> structured TransportationEvent (§26A).
// The DETERMINISTIC solver owns feasibility, ranking, flexibility (§26B).
//
// Defect 4 (abuse protection):
//   - Requires an authenticated NextAuth session (401 if absent).
//   - In-memory rate limit: 30 solves per session email per 60s (429 if exceeded).
//   - Body-size caps: intent > 2000 chars OR event JSON > 8000 chars → 413.
//   - Existing LLM-parse + deterministic-solve flow is otherwise unchanged.
//   - Works for all logged-in users including demo accounts (any valid session).
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { TransportationEvent, SolveResponse, Plan, FlexibilityOffer } from "@/lib/oryxx/types";
import { parseIntent, heuristicParse } from "@/lib/oryxx/parse";
import { solveTransportationEvent } from "@/lib/oryxx/solver";
import { authOptions } from "@/lib/auth/options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

// --- In-memory rate limiter (per session email, sliding 60s window) ----------
// Simple Map<email, number[]> of timestamps. Adequate for abuse protection on
// a single instance; on Vercel serverless, each instance has its own Map (so
// the effective limit is per-instance — acceptable for "simple" abuse defense).
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function rateLimitCheck(email: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateBuckets.get(email) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_LIMIT_MAX) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    rateBuckets.set(email, recent); // refresh stored list (drop stale entries)
    return { ok: false, retryAfterSec };
  }
  recent.push(now);
  rateBuckets.set(email, recent);
  return { ok: true, retryAfterSec: 0 };
}

// --- Body-size caps (defence against oversized / abusive payloads) ----------
const MAX_INTENT_CHARS = 2000;
const MAX_EVENT_CHARS = 8000;

export async function POST(req: Request) {
  // --- Auth: require an authenticated NextAuth session ---
  const session = await getServerSession(authOptions);
  const email = (session?.user as any)?.email as string | undefined;
  if (!email) {
    return bad("Authentication required.", 401);
  }

  // --- Rate limit: 30 solves per email per 60s ---
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

  // --- Body-size caps ---
  if (typeof body?.intent === "string" && body.intent.length > MAX_INTENT_CHARS) {
    return bad(`Intent too long (max ${MAX_INTENT_CHARS} chars).`, 413);
  }
  if (body?.event != null) {
    // Cheap pre-flight check via JSON.stringify length. Skipped for primitives.
    let eventJsonLen: number;
    try {
      eventJsonLen = JSON.stringify(body.event).length;
    } catch {
      eventJsonLen = Infinity; // unstringifiable → reject
    }
    if (eventJsonLen > MAX_EVENT_CHARS) {
      return bad(`Event payload too large (max ${MAX_EVENT_CHARS} chars).`, 413);
    }
  }

  let event: TransportationEvent;
  let parsedBy: SolveResponse["parsedBy"] = "structured";

  try {
    if (body?.event && body.event.origin && body.event.destination) {
      // structured event from the builder UI — merge defaults
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

    const result = solveTransportationEvent(event);

    const plans: Plan[] = result.plans;
    const offers: FlexibilityOffer[] = result.flexibilityOffers;

    const response: SolveResponse = {
      event,
      parsedBy,
      plans,
      flexibilityOffers: offers,
      watchEstimate: result.watchEstimate,
      unknowns: result.unknowns,
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[oryxx/solve] error:", err);
    return NextResponse.json(
      { error: "Solver failure", detail: (err as Error)?.message ?? String(err) },
      { status: 500 },
    );
  }
}

// Ensure required fields exist even if the structured builder sent partial data.
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
