// ORYXX solve endpoint.
// POST /api/oryxx/solve
//   body: { intent?: string; event?: TransportationEvent }
// The LLM parses intent -> structured TransportationEvent (§26A).
// The DETERMINISTIC solver owns feasibility, ranking, flexibility (§26B).
import { NextResponse } from "next/server";
import type { TransportationEvent, SolveResponse, Plan, FlexibilityOffer } from "@/lib/oryxx/types";
import { parseIntent, heuristicParse } from "@/lib/oryxx/parse";
import { solveTransportationEvent } from "@/lib/oryxx/solver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return bad("Invalid JSON body.");
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
