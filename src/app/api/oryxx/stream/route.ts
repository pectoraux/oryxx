// ORYXX — Continuous re-optimization stream (SSE).
//
// Replaces the socket.io mini-service so the app behaves identically on
// Vercel (serverless) and space-z.ai. Edge Runtime streams Server-Sent Events;
// EventSource on the client auto-reconnects and resumes via Last-Event-ID.
//
// The event schedule is deterministic given the plan context, so a reconnect
// after a dropped connection replays only events that should have fired by
// the elapsed time since the client started monitoring.

import type { OptimizationEvent, OptimizationEventKind } from "@/lib/oryxx/types";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

interface PlanContext {
  planId: string;
  baseCost: number;
  arrive: string;
  latestArrival?: string;
  usesLatentSupply: boolean;
  autonomy: number;
  watchMode: boolean;
}

function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSchedule(ctx: PlanContext): { id: number; atSec: number; ev: OptimizationEvent }[] {
  const r = rand(
    ctx.planId.split("").reduce((a, c) => a + c.charCodeAt(0), 0) +
      Math.round(ctx.baseCost * 100),
  );
  const baseArrive = toMin(ctx.arrive);
  const slack = ctx.latestArrival ? toMin(ctx.latestArrival) - baseArrive : 12;
  const events: { id: number; atSec: number; ev: OptimizationEvent }[] = [];
  let n = 0;
  const mk = (
    atSec: number,
    kind: OptimizationEventKind,
    message: string,
    severity: OptimizationEvent["severity"],
    extra: Partial<OptimizationEvent> = {},
  ): typeof events[number] => ({
    id: n++,
    atSec,
    ev: {
      id: `${ctx.planId}-${n}`,
      kind,
      message,
      timestamp: new Date().toISOString(),
      severity,
      ...extra,
    },
  });

  events.push(
    mk(1, "price_drop", `Bolt leg repriced $${(r() * 4 + 1.5).toFixed(2)} lower on your route.`, "good", {
      deltaCost: -(Math.round((r() * 4 + 1.5) * 100) / 100),
    }),
  );
  events.push(
    mk(4, "new_latent_supply", `New latent supply matched: a commuter on a parallel route offered 2 spare seats.`, "info", {
      deltaCost: -(Math.round((r() * 5 + 4) * 100) / 100),
    }),
  );
  events.push(
    mk(7, "traffic_incident", `Traffic incident detected on an alternative corridor — ORYXX deprioritized it; your selected plan is unaffected.`, "warn"),
  );
  if (slack < 8) {
    events.push(
      mk(8, "eta_update", `ETA variance increased (+${Math.round(r() * 8 + 6)}m); on-time probability revised downward.`, "warn"),
    );
  }
  const better = ctx.usesLatentSupply ? r() * 2 + 0.5 : r() * 4 + 2;
  const newCost = Math.max(2, Math.round((ctx.baseCost - better) * 100) / 100);
  const acts = ctx.autonomy >= 4;
  events.push(
    mk(11, "reoptimized", acts
      ? `Re-optimized and ${ctx.autonomy >= 5 ? "portfolio-adjusted" : "auto-rebooked"} a cheaper equivalent. New best: $${newCost.toFixed(2)}.`
      : `Found a cheaper equivalent ($${newCost.toFixed(2)}, was $${ctx.baseCost.toFixed(2)}). ${ctx.autonomy >= 2 ? "Negotiating/reserving on your behalf." : "Awaiting your approval."}`,
      "good",
      { reoptimizedPlanId: ctx.planId, newCost, deltaCost: Math.round((newCost - ctx.baseCost) * 100) / 100 },
    ),
  );
  events.push(
    mk(14, "cancellation", `A backup option was cancelled by its provider. Your selected plan remains confirmed.`, "info"),
  );
  events.push(
    mk(17, "price_surge", `Demand surge raised a non-selected alternative by $${(r() * 2.5 + 1).toFixed(2)}. You're unaffected.`, "info", {
      deltaCost: Math.round((r() * 2.5 + 1) * 100) / 100,
    }),
  );
  if (ctx.watchMode || ctx.autonomy >= 4) {
    const low = Math.round(ctx.baseCost * 0.78 * 100) / 100;
    events.push(
      mk(20, "watch_triggered", ctx.autonomy >= 4
        ? `Watch threshold reached ($${low.toFixed(2)}). Booked within your constraints — confirmation pending.`
        : `Watch threshold reached ($${low.toFixed(2)}). Tap to book before this window closes.`,
        "good",
        { newCost: low, deltaCost: Math.round((low - ctx.baseCost) * 100) / 100 },
      ),
    );
  }
  return events;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ctx: PlanContext = {
    planId: url.searchParams.get("planId") ?? "plan-0",
    baseCost: Number(url.searchParams.get("baseCost") ?? 0),
    arrive: url.searchParams.get("arrive") ?? "08:00",
    latestArrival: url.searchParams.get("latestArrival") ?? undefined,
    usesLatentSupply: url.searchParams.get("usesLatentSupply") === "1",
    autonomy: Number(url.searchParams.get("autonomy") ?? 1),
    watchMode: url.searchParams.get("watchMode") === "1",
  };
  const clientStart = Number(url.searchParams.get("start") ?? Date.now());
  const lastId = req.headers.get("last-event-id");
  const lastIdx = lastId ? parseInt(lastId, 10) : -1;

  const schedule = buildSchedule(ctx);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        }
      };
      // initial retry hint so EventSource backs off if the stream ends
      safeEnqueue(`: ORYXX continuous re-optimization\nretry: 5000\n\n`);

      const tick = () => {
        if (closed) return;
        const elapsed = (Date.now() - clientStart) / 1000;
        let sentAny = false;
        for (const item of schedule) {
          if (item.id <= lastIdx) continue; // already sent before reconnect
          if (item.atSec <= elapsed && !item.sent) {
            safeEnqueue(`id: ${item.id}\nevent: optimizer\ndata: ${JSON.stringify(item.ev)}\n\n`);
            (item as any).sent = true;
            sentAny = true;
          }
        }
        // when all events have fired, send a terminator and close
        const allSent = schedule
          .filter((s) => s.id > lastIdx)
          .every((s) => (s as any).sent);
        if (allSent && elapsed > (schedule[schedule.length - 1]?.atSec ?? 99) + 1) {
          safeEnqueue(`event: done\ndata: ${JSON.stringify({ message: "Monitoring cycle complete. ORYXX continues watching in the background." })}\n\n`);
          try {
            controller.close();
          } catch {}
          closed = true;
          return;
        }
        setTimeout(tick, 1000);
      };
      tick();

      // Vercel Edge will eventually terminate the connection; the client
      // EventSource reconnects with Last-Event-ID and we resume.
      const watchdog = setTimeout(() => {
        closed = true;
        try {
          controller.close();
        } catch {}
      }, 30000);
      // Allow cleanup: store watchdog so it can't be GC'd before firing.
      (globalThis as any).__oryxx_watchdog = watchdog;
    },
    cancel() {
      // client disconnected — ReadableStream handles cleanup automatically
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
