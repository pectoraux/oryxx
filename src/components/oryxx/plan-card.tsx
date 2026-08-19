"use client";

import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Clock,
  DollarSign,
  ShieldCheck,
  Leaf,
  GitBranch,
  Footprints,
  Sparkles,
  Radio,
  ChevronRight,
  Gauge,
} from "lucide-react";
import type { Plan } from "@/lib/oryxx/types";
import { fmtDuration } from "@/lib/oryxx/world";
import {
  MODE_ICON,
  MODE_LABEL,
  MODE_COLOR,
  TAG_META,
  confidenceColor,
  money,
  onTimeColor,
} from "./ui-helpers";

function Stat({
  icon: Icon,
  label,
  value,
  valueClass,
}: {
  icon: any;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <span className={`text-sm font-semibold ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}

export function ItineraryTimeline({ plan }: { plan: Plan }) {
  return (
    <ol className="relative space-y-0.5">
      {plan.segments.map((s, i) => {
        const Icon = MODE_ICON[s.mode];
        const color = MODE_COLOR[s.mode];
        const isLast = i === plan.segments.length - 1;
        return (
          <li key={i} className="relative pl-0">
            <div className="flex items-stretch gap-3">
              {/* vertical rail */}
              <div className="flex w-9 flex-col items-center">
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-full border ${color}`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                {!isLast && (
                  <div className="my-0.5 w-px flex-1 bg-border" aria-hidden />
                )}
                {isLast && <div className="h-2" />}
              </div>
              {/* content */}
              <div className="flex-1 pb-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{s.provider}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {MODE_LABEL[s.mode]}
                  </span>
                  {s.isLatentSupply && (
                    <Badge
                      variant="outline"
                      className="border-violet-500/40 bg-violet-500/10 text-[10px] text-violet-700 dark:text-violet-300"
                    >
                      <Sparkles className="mr-1 h-2.5 w-2.5" />
                      Latent supply
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {s.depart} <ChevronRight className="inline h-3 w-3" /> {s.arrive}{" "}
                  · {fmtDuration(s.durationMin)} · {s.distanceKm} km · {money(s.cost)}
                </div>
                <div className="text-xs text-muted-foreground/80">
                  {s.from} <ChevronRight className="inline h-3 w-3" /> {s.to}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function PlanCard({
  plan,
  selected,
  onSelect,
  watching,
}: {
  plan: Plan;
  selected: boolean;
  onSelect: () => void;
  watching?: boolean;
}) {
  const meta = TAG_META[plan.tag];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Card
        className={`relative overflow-hidden py-0 ${selected ? meta.ring : "ring-1 ring-transparent"} ${
          plan.tag === "best_overall" ? "border-emerald-500/40" : ""
        }`}
      >
        {plan.tag === "best_overall" && (
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500" />
        )}
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={`${meta.badge} rounded`}>{meta.label}</Badge>
              {plan.usesLatentSupply && (
                <Badge variant="outline" className="border-violet-500/40 text-violet-700 dark:text-violet-300">
                  <Sparkles className="mr-1 h-3 w-3" /> Shared trip
                </Badge>
              )}
              {watching && (
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
                  <Radio className="mr-1 h-3 w-3 animate-pulse" /> Live
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{plan.headline}</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">{money(plan.totalCost)}</div>
            <div className="text-xs text-muted-foreground">total</div>
          </div>
        </div>

        <div className="px-4 pt-3">
          <ItineraryTimeline plan={plan} />
        </div>

        <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat
            icon={Clock}
            label="Duration"
            value={fmtDuration(plan.totalDurationMin)}
          />
          <Stat
            icon={Clock}
            label="Depart → Arrive"
            value={`${plan.depart}–${plan.arrive}`}
          />
          <Stat
            icon={ShieldCheck}
            label="On-time"
            value={`${Math.round(plan.onTimeProbability * 100)}%`}
            valueClass={onTimeColor(plan.onTimeProbability)}
          />
          <Stat
            icon={Gauge}
            label="Reliability"
            value={`${Math.round(plan.reliability * 100)}%`}
          />
          <Stat
            icon={GitBranch}
            label="Transfers"
            value={String(plan.transfers)}
          />
          <Stat
            icon={Footprints}
            label="Walking"
            value={`${plan.walkingKm} km`}
          />
          <Stat
            icon={Leaf}
            label="CO₂e"
            value={`${plan.emissionsKgCo2e} kg`}
          />
          <Stat
            icon={DollarSign}
            label="Confidence"
            value={`${Math.round(plan.confidence * 100)}%`}
            valueClass={confidenceColor(plan.confidence)}
          />
        </div>

        <div className="mx-4 mb-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Tradeoff: </span>
          {plan.tradeoffNote}
        </div>

        <div className="flex items-center gap-2 border-t bg-muted/20 px-4 py-3">
          <Button
            size="sm"
            variant={selected ? "default" : "outline"}
            onClick={onSelect}
            className={selected ? "bg-emerald-600 hover:bg-emerald-700" : ""}
          >
            {selected ? "Selected" : "Select & monitor"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Expected utility{" "}
            <span className="font-semibold text-foreground">
              {Math.round(plan.score * 100)}%
            </span>{" "}
            · ETA ±{plan.etaVarianceMin}m
          </span>
        </div>
      </Card>
    </motion.div>
  );
}
