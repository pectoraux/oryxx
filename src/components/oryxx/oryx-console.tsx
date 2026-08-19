"use client";

import { useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Navigation,
  Wand2,
  Radar,
  Network,
  ShieldCheck,
  Sparkles,
  Github,
  ArrowRight,
  RotateCcw,
  Layers,
  MapPinned,
} from "lucide-react";
import type {
  SolveResponse,
  TransportationEvent,
  FlexibilityOffer,
  Plan,
} from "@/lib/oryxx/types";
import { IntentConsole, type SolvePayload } from "@/components/oryxx/intent-console";
import { ParsedEventCard } from "@/components/oryxx/parsed-event-card";
import { PlanCard } from "@/components/oryxx/plan-card";
import { FlexibilityOffers } from "@/components/oryxx/flexibility-offers";
import { OptimizationFeed } from "@/components/oryxx/optimization-feed";

function addMinutes(hhmm: string, delta: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m + delta;
  total = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

export function OryxConsole() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<SolveResponse | null>(null);
  const [lastEvent, setLastEvent] = useState<TransportationEvent | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [appliedOfferId, setAppliedOfferId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const callSolve = useCallback(
    async (payload: SolvePayload) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/oryxx/solve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `Solver returned ${res.status}`);
        }
        const data: SolveResponse = await res.json();
        setResponse(data);
        setLastEvent(data.event);
        setSelectedId(data.plans[0]?.id ?? null);
        setAppliedOfferId(null);
        toast({
          title: `${data.plans.length} feasible plans found`,
          description:
            data.parsedBy === "llm"
              ? "Intent parsed by ORYXX LLM; plans ranked deterministically."
              : data.parsedBy === "heuristic"
              ? "LLM unavailable — heuristic parse used. Solver still deterministic."
              : "Structured event solved deterministically.",
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? "Unknown error";
        setError(msg);
        toast({ title: "Solver error", description: msg, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  const applyOffer = useCallback(
    (offer: FlexibilityOffer) => {
      if (!lastEvent) return;
      setAppliedOfferId(offer.id);
      let next: TransportationEvent = { ...lastEvent };
      let renotify = "";
      switch (offer.kind) {
        case "shift_time": {
          const delta = offer.id === "flex-later" ? 25 : -20;
          next = {
            ...next,
            earliestDeparture: addMinutes(next.earliestDeparture, delta),
            preferredDeparture: next.preferredDeparture
              ? addMinutes(next.preferredDeparture, delta)
              : addMinutes(next.earliestDeparture, delta),
          };
          renotify = `Re-solving with departure shifted ${delta > 0 ? "+" : ""}${delta} min.`;
          break;
        }
        case "allow_transfer": {
          const cur = next.constraints.maxTransfers ?? 2;
          next = {
            ...next,
            constraints: { ...next.constraints, maxTransfers: cur + 1 },
          };
          renotify = `Re-solving allowing up to ${cur + 1} transfers.`;
          break;
        }
        case "share_ride": {
          next = {
            ...next,
            objectives: { ...next.objectives, cost: 1, comfort: 0.15, safety: 0.5 },
          };
          renotify = "Re-solving prioritizing cheapest (incl. latent supply).";
          break;
        }
        case "book_earlier": {
          toast({
            title: "Advance booking noted",
            description:
              "Advance-contract pricing applies when real supply is connected. This prototype keeps the current plan.",
          });
          return;
        }
        case "wait_watch": {
          toast({
            title: "Watch mode armed",
            description: "ORYXX will alert if a cheaper plan appears. Open the live feed below.",
          });
          return;
        }
      }
      setLastEvent(next);
      callSolve({ event: next });
      if (renotify) toast({ title: "Re-optimizing", description: renotify });
    },
    [lastEvent, callSolve, toast],
  );

  const selectedPlan: Plan | null = useMemo(() => {
    if (!response || !selectedId) return response?.plans[0] ?? null;
    return response.plans.find((p) => p.id === selectedId) ?? response.plans[0] ?? null;
  }, [response, selectedId]);

  const reset = () => {
    setResponse(null);
    setLastEvent(null);
    setSelectedId(null);
    setAppliedOfferId(null);
    setError(null);
  };

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">
      {/* Hero / thesis */}
      <section id="thesis" className="space-y-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="space-y-3"
        >
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
            <Sparkles className="mr-1 h-3 w-3" /> MVP wedge — the intelligence core
          </Badge>
          <h1 className="max-w-3xl text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
            Move anything from A to B —{" "}
            <span className="text-emerald-600">optimally</span>, across every mode and every
            market.
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
            Given a transportation intent, ORYXX parses it into a structured event, solves it
            deterministically across multi-hop routes, ranks the best feasible plans with
            explicit tradeoffs and honest confidence, and continuously re-optimizes — turning
            time, transfers, and latent supply into levers.
          </p>
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1 rounded-full border px-2 py-1">
              <Wand2 className="h-3 w-3" /> LLM parses intent
            </span>
            <span className="flex items-center gap-1 rounded-full border px-2 py-1">
              <Network className="h-3 w-3" /> Deterministic solver owns feasibility
            </span>
            <span className="flex items-center gap-1 rounded-full border px-2 py-1">
              <ShieldCheck className="h-3 w-3" /> Honest confidence & unknowns
            </span>
            <span className="flex items-center gap-1 rounded-full border px-2 py-1">
              <MapPinned className="h-3 w-3" /> Time is an optimization variable
            </span>
          </div>
        </motion.div>
      </section>

      <IntentConsole onSolve={callSolve} loading={loading} />

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {response && (
        <section className="space-y-5">
          <ParsedEventCard response={response} />

          {response.watchEstimate && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5">
              <p className="text-xs text-emerald-800 dark:text-emerald-200">
                <Sparkles className="mr-1 inline h-3.5 w-3.5" />
                Let ORYXX search for {response.watchEstimate.hours}h → estimated{" "}
                <span className="font-semibold">
                  ${response.watchEstimate.low.toFixed(2)}–
                  {response.watchEstimate.high.toFixed(2)}
                </span>{" "}
                for the best-overall route.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-emerald-500/40 text-[11px] text-emerald-700 dark:text-emerald-300"
                onClick={() =>
                  applyOffer(
                    response.flexibilityOffers.find((o) => o.kind === "wait_watch")!,
                  )
                }
              >
                Arm watch mode <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
            {/* Plans column */}
            <div className="space-y-4 lg:col-span-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-muted-foreground">
                  {response.plans.length} feasible plan
                  {response.plans.length === 1 ? "" : "s"}
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px] text-muted-foreground"
                  onClick={reset}
                >
                  <RotateCcw className="mr-1 h-3 w-3" /> Reset
                </Button>
              </div>
              <div className="space-y-4">
                {response.plans.map((p) => (
                  <PlanCard
                    key={p.id}
                    plan={p}
                    selected={selectedPlan?.id === p.id}
                    onSelect={() => setSelectedId(p.id)}
                    watching={selectedPlan?.id === p.id}
                  />
                ))}
              </div>
            </div>

            {/* Side column: flexibility + continuous optimization */}
            <div className="space-y-4 lg:col-span-2">
              <FlexibilityOffers
                offers={response.flexibilityOffers}
                onApply={applyOffer}
                appliedId={appliedOfferId}
              />
              <OptimizationFeed plan={selectedPlan} event={lastEvent} />
            </div>
          </div>
        </section>
      )}

      {/* Architecture / principles */}
      <section id="architecture" className="space-y-4 pt-4">
        <Separator />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="rounded-lg border bg-card p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <p.icon className="h-3.5 w-3.5 text-emerald-600" />
                <span className="text-xs font-semibold">{p.title}</span>
              </div>
              <p className="text-[11px] leading-tight text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

const PRINCIPLES = [
  {
    title: "Transportation event primitive",
    icon: Network,
    body: "Every request is a structured event: object, origin, destination, time window, constraints, objectives, risk, autonomy.",
  },
  {
    title: "LLM ≠ source of truth",
    icon: ShieldCheck,
    body: "The LLM only understands intent. A deterministic engine enforces hard constraints, feasibility, and guarantees.",
  },
  {
    title: "Time is an optimization variable",
    icon: MapPinned,
    body: "Leaving 25 min later or allowing one more transfer can save real money. ORYXX makes the value of flexibility explicit.",
  },
  {
    title: "Latent supply (NPDs)",
    icon: Sparkles,
    body: "A commuter's empty seats are latent supply. ORYXX matches pre-existing trips to new demand — creating matches that didn't exist.",
  },
];
