// ORYXX — Continuous Re-Optimization mini-service (master prompt §20).
//
// A standalone socket.io service on port 3003. Clients subscribe with the
// context of a chosen plan; the service streams simulated optimization events:
//   price_drop, price_surge, traffic_incident, new_latent_supply,
//   eta_update, cancellation, reoptimized, watch_triggered.
//
// If the user's autonomy level authorizes it (L4 auto-book / L5 portfolio),
// the service will emit `reoptimized` events that *act* on the user's behalf
// (reserve / rebook). This is the live embodiment of §20 + §22.
//
// Caddy gateway rule: client connects to io("/?XTransformPort=3003").

import { createServer } from "http";
import { Server } from "socket.io";
import { randomBytes } from "crypto";

const PORT = 3003;

interface PlanContext {
  planId: string;
  baseCost: number;
  arrive: string; // HH:mm
  latestArrival?: string;
  usesLatentSupply: boolean;
  autonomy: number; // 0..5
  watchMode: boolean;
}

function id() {
  return randomBytes(6).toString("hex");
}

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function toHHMM(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
}

const httpServer = createServer();
const io = new Server(httpServer, {
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// active simulation timers per socket
const timers = new Map<string, NodeJS.Timeout[]>();

io.on("connection", (socket) => {
  console.log(`[oryxx-optimizer] client connected: ${socket.id}`);

  socket.on("subscribe", async (ctx: PlanContext) => {
    // clear any prior timers
    clearTimers(socket.id);
    console.log(`[oryxx-optimizer] subscribe`, ctx);

    // immediate acknowledgement
    socket.emit("optimizer:started", {
      planId: ctx.planId,
      message: `ORYXX is now monitoring your plan and continuously re-optimizing.`,
      timestamp: new Date().toISOString(),
      autonomy: ctx.autonomy,
      watchMode: ctx.watchMode,
    });

    const localTimers: NodeJS.Timeout[] = [];

    // helper to push an event
    const emit = (payload: any) => {
      socket.emit("optimizer:event", payload);
    };

    // Schedule a plausible sequence of events over ~60s.
    const baseArrive = toMin(ctx.arrive);
    const slack = ctx.latestArrival ? toMin(ctx.latestArrival) - baseArrive : 12;

    // 1) ~3s: a price movement
    localTimers.push(
      setTimeout(() => {
        const drop = Math.round(rand(1.5, 5.5) * 100) / 100;
        emit({
          id: id(),
          kind: "price_drop",
          message: `Bolt leg repriced $${drop.toFixed(2)} lower on your route.`,
          timestamp: new Date().toISOString(),
          severity: "good",
          deltaCost: -drop,
        });
      }, 3000),
    );

    // 2) ~9s: latent supply opportunity (always relevant — we're a marketplace)
    localTimers.push(
      setTimeout(() => {
        const save = Math.round(rand(4, 9) * 100) / 100;
        emit({
          id: id(),
          kind: "new_latent_supply",
          message: `New latent supply matched: a commuter on a parallel route offered 2 spare seats.`,
          timestamp: new Date().toISOString(),
          severity: "info",
          deltaCost: -save,
        });
      }, 9000),
    );

    // 3) ~16s: traffic incident on a candidate alternative
    localTimers.push(
      setTimeout(() => {
        const etaHit = Math.round(rand(6, 14));
        emit({
          id: id(),
          kind: "traffic_incident",
          message: `Traffic incident detected on an alternative corridor — ORYXX deprioritized it; your selected plan is unaffected.`,
          timestamp: new Date().toISOString(),
          severity: "warn",
        });
        // arrival may slip on riskier plans
        if (slack < 8) {
          emit({
            id: id(),
            kind: "eta_update",
            message: `ETA variance increased (+${etaHit}m); on-time probability revised downward.`,
            timestamp: new Date().toISOString(),
            severity: "warn",
          });
        }
      }, 16000),
    );

    // 4) ~24s: re-optimization result
    localTimers.push(
      setTimeout(() => {
        const better = ctx.usesLatentSupply ? rand(0.5, 2.5) : rand(2, 6);
        const newCost = Math.max(2, Math.round((ctx.baseCost - better) * 100) / 100);
        const acts = ctx.autonomy >= 4;
        emit({
          id: id(),
          kind: "reoptimized",
          message: acts
            ? `Re-optimized and ${ctx.autonomy >= 5 ? "portfolio-adjusted" : "auto-rebooked"} a cheaper equivalent. New best: $${newCost.toFixed(2)}.`
            : `Found a cheaper equivalent ($${newCost.toFixed(2)}, was $${ctx.baseCost.toFixed(2)}). ${
                ctx.autonomy >= 2 ? "Negotiating/reserving on your behalf." : "Awaiting your approval."
              }`,
          timestamp: new Date().toISOString(),
          severity: "good",
          reoptimizedPlanId: ctx.planId,
          newCost,
          deltaCost: Math.round((newCost - ctx.baseCost) * 100) / 100,
        });
      }, 24000),
    );

    // 5) ~36s: cancellation risk on a non-selected plan
    localTimers.push(
      setTimeout(() => {
        emit({
          id: id(),
          kind: "cancellation",
          message: `A backup option was cancelled by its provider. Your selected plan remains confirmed.`,
          timestamp: new Date().toISOString(),
          severity: "info",
        });
      }, 36000),
    );

    // 6) ~46s: price surge (so it isn't a monotonically happy story — §19 honesty)
    localTimers.push(
      setTimeout(() => {
        const surge = Math.round(rand(1, 3.5) * 100) / 100;
        emit({
          id: id(),
          kind: "price_surge",
          message: `Demand surge raised a non-selected alternative by $${surge.toFixed(2)}. You're unaffected.`,
          timestamp: new Date().toISOString(),
          severity: "info",
          deltaCost: surge,
        });
      }, 46000),
    );

    // 7) ~55s: watch-mode trigger (if watchMode or autonomy>=4)
    if (ctx.watchMode || ctx.autonomy >= 4) {
      localTimers.push(
        setTimeout(() => {
          const low = Math.round(ctx.baseCost * 0.78 * 100) / 100;
          emit({
            id: id(),
            kind: "watch_triggered",
            message: ctx.autonomy >= 4
              ? `Watch threshold reached ($${low.toFixed(2)}). Booked within your constraints — confirmation pending.`
              : `Watch threshold reached ($${low.toFixed(2)}). Tap to book before this window closes.`,
            timestamp: new Date().toISOString(),
            severity: "good",
            newCost: low,
            deltaCost: Math.round((low - ctx.baseCost) * 100) / 100,
          });
        }, 55000),
      );
    }

    timers.set(socket.id, localTimers);
  });

  socket.on("unsubscribe", () => {
    clearTimers(socket.id);
    socket.emit("optimizer:stopped", { timestamp: new Date().toISOString() });
  });

  socket.on("disconnect", () => {
    clearTimers(socket.id);
    console.log(`[oryxx-optimizer] client disconnected: ${socket.id}`);
  });

  socket.on("error", (err) => {
    console.error(`[oryxx-optimizer] socket error (${socket.id}):`, err);
  });
});

function clearTimers(socketId: string) {
  const t = timers.get(socketId);
  if (t) {
    t.forEach((h) => clearTimeout(h));
    timers.delete(socketId);
  }
}

httpServer.listen(PORT, () => {
  console.log(`[oryxx-optimizer] continuous re-optimization service running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});
