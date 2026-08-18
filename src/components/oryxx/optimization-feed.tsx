"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Radio,
  Activity,
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Sparkles,
  Clock,
  Ban,
  RefreshCw,
  Bell,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import type { OptimizationEvent, Plan, TransportationEvent } from "@/lib/oryxx/types";

const SEVERITY_STYLE = {
  info: "border-border bg-muted/30 text-muted-foreground",
  good: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  critical: "border-rose-500/50 bg-rose-500/5 text-rose-700 dark:text-rose-300",
} as const;

const KIND_ICON = {
  price_drop: TrendingDown,
  price_surge: TrendingUp,
  traffic_incident: AlertTriangle,
  new_latent_supply: Sparkles,
  eta_update: Clock,
  cancellation: Ban,
  reoptimized: RefreshCw,
  watch_triggered: Bell,
} as const;

export function OptimizationFeed({
  plan,
  event,
}: {
  plan: Plan | null;
  event: TransportationEvent | null;
}) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<OptimizationEvent[]>([]);
  const [watching, setWatching] = useState(false);
  const [active, setActive] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const startRef = useRef<number>(0);

  const cleanup = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  };

  useEffect(() => {
    return () => cleanup();
  }, []);

  const subscribe = () => {
    if (!plan || !event) return;
    cleanup();
    setEvents([]);
    setDone(false);
    setError(null);
    startRef.current = Date.now();

    const params = new URLSearchParams({
      start: String(startRef.current),
      planId: plan.id,
      baseCost: String(plan.totalCost),
      arrive: plan.arrive,
      latestArrival: event.latestArrival ?? "",
      usesLatentSupply: plan.usesLatentSupply ? "1" : "0",
      autonomy: String(event.autonomy),
      watchMode: watching ? "1" : "0",
    });
    const es = new EventSource(`/api/oryxx/stream?${params}`);
    esRef.current = es;

    setConnected(true);
    setActive(true);

    es.addEventListener("optimizer", (e: MessageEvent) => {
      try {
        const ev: OptimizationEvent = JSON.parse(e.data);
        setEvents((prev) => [ev, ...prev].slice(0, 40));
      } catch {}
    });
    es.addEventListener("done", () => {
      setDone(true);
      setActive(false);
      cleanup();
    });
    es.onerror = () => {
      // EventSource auto-reconnects unless we close it. If we've already
      // finished, treat the disconnect as graceful.
      if (done) {
        cleanup();
        setConnected(false);
        setActive(false);
        return;
      }
      setError("Stream interrupted — ORYXX is reconnecting…");
      // let EventSource retry; if it fails repeatedly it'll stay in error state
    };
  };

  const stop = () => {
    cleanup();
    setActive(false);
    setConnected(false);
  };

  const noPlan = !plan;

  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-semibold">Continuous Re-Optimization</span>
          {active && (
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
              <Radio className="mr-1 h-3 w-3 animate-pulse" /> monitoring
            </Badge>
          )}
          {done && (
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="mr-1 h-3 w-3" /> cycle complete
            </Badge>
          )}
        </div>
        <Badge
          variant="outline"
          className={
            connected
              ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
              : "border-rose-500/40 text-rose-700 dark:text-rose-300"
          }
        >
          <span
            className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
              connected ? "bg-emerald-500" : "bg-rose-500"
            }`}
          />
          {connected ? "live" : "offline"}
        </Badge>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={watching} onCheckedChange={setWatching} />
            Watch mode (book only if a cheaper plan appears)
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={stop}
              disabled={!active}
              className="h-7 text-[11px]"
            >
              Stop
            </Button>
            <Button
              size="sm"
              onClick={subscribe}
              disabled={noPlan || active}
              className="h-7 bg-emerald-600 text-[11px] hover:bg-emerald-700"
            >
              {active ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" /> monitoring
                </>
              ) : (
                <>
                  <Radio className="mr-1 h-3 w-3" /> Monitor selected plan
                </>
              )}
            </Button>
          </div>
        </div>

        {noPlan && (
          <p className="text-[11px] text-muted-foreground">
            Select a plan above to let ORYXX continuously monitor prices, traffic, and
            latent-supply opportunities and re-optimize it.
          </p>
        )}
        {error && (
          <p className="text-[11px] text-amber-600">{error}</p>
        )}

        <ScrollArea className="h-64 w-full rounded-md border">
          <div className="space-y-1.5 p-2">
            {events.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center text-center text-[11px] text-muted-foreground">
                <Activity className="mb-1 h-5 w-5 opacity-40" />
                {active
                  ? "Listening for price changes, latent-supply matches, traffic incidents, and re-optimizations…"
                  : connected
                  ? "Ready to monitor."
                  : "Click “Monitor selected plan” to start the live feed."}
              </div>
            ) : (
              events.map((ev) => {
                const Icon = KIND_ICON[ev.kind] ?? Activity;
                return (
                  <div
                    key={ev.id}
                    className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs ${SEVERITY_STYLE[ev.severity]}`}
                  >
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="leading-snug">{ev.message}</p>
                      <p className="mt-0.5 text-[10px] opacity-70">
                        {new Date(ev.timestamp).toLocaleTimeString()} · {ev.kind.replace(/_/g, " ")}
                        {ev.deltaCost != null && ev.deltaCost < 0 && (
                          <span className="ml-1 font-semibold text-emerald-600">
                            {ev.deltaCost > 0 ? "+" : ""}
                            {ev.deltaCost.toFixed(2)}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>

        <p className="text-[10px] leading-tight text-muted-foreground">
          Autonomy L{event?.autonomy ?? 0} governs whether ORYXX only notifies, reserves,
          auto-rebooks, or continuously re-optimizes your whole portfolio. Watch estimates are
          probabilistic, not guarantees.
        </p>
      </div>
    </Card>
  );
}
