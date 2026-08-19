"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Play, Loader2, Database, AlertTriangle, ShieldAlert, Info, CheckCircle2,
  TrendingUp, Activity, Layers,
} from "lucide-react";
import type { CapacityExperimentResult } from "@/lib/oryxx/real/evidence/types";

export function CapacityLab() {
  const { toast } = useToast();
  const [numDemands, setNumDemands] = useState(150);
  const [willingness, setWillingness] = useState(0.15);
  const [execution, setExecution] = useState(0.45);
  const [detour, setDetour] = useState(3.0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CapacityExperimentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oryxx/capacity/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          numDemands, willingness, executionProbability: execution,
          detourToleranceKm: detour, minCompensation: 3.0, seed: 42,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data: CapacityExperimentResult = await res.json();
      setResult(data);
      toast({
        title: "Capacity evidence experiment complete",
        description: `${data.totalMovements} real movements | ${data.movementsWithObservedCapacity} with OBSERVED capacity | ${data.robustOpportunitiesWithObservedCapacity} robust opportunities`,
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? "Unknown error";
      setError(msg);
      toast({ title: "Experiment failed", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Capacity Evidence Lab</p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Separates observed movement / observed capacity / assumed willingness
              </p>
            </div>
          </div>
          <Button size="sm" onClick={run} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700">
            {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…</>
                   : <><Play className="mr-2 h-4 w-4" /> Run experiment</>}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <SliderField label="Demands" value={numDemands} min={50} max={500} step={50} onChange={setNumDemands} />
          <SliderField label="Willingness (ASSUMED)" value={willingness} min={0.05} max={0.5} step={0.05} onChange={setWillingness} format={(v) => `${Math.round(v * 100)}%`} />
          <SliderField label="Execution prob (ASSUMED)" value={execution} min={0.2} max={0.8} step={0.05} onChange={setExecution} format={(v) => `${Math.round(v * 100)}%`} />
          <SliderField label="Detour tolerance (ASSUMED)" value={detour} min={1} max={6} step={0.5} onChange={setDetour} format={(v) => `${v}km`} />
        </div>
      </Card>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-2 text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {result && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-6">
          {/* Evidence ladder */}
          <EvidenceLadderCard result={result} />

          {/* Headline metrics */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard icon={Database} label="Real movements" value={String(result.totalMovements)} sub={`${result.movementsWithObservedCapacity} with observed capacity`} tone="emerald" />
            <MetricCard icon={CheckCircle2} label="Robust w/ observed capacity" value={String(result.robustOpportunitiesWithObservedCapacity)} sub={`${result.robustOpportunitiesPer1000} per 1000`} tone="emerald" />
            <MetricCard icon={TrendingUp} label="Potential value" value={`$${result.potentialValue}`} sub="all candidates" tone="amber" />
            <MetricCard icon={Activity} label="Executed value" value={`$${result.executedValue}`} sub="× willingness × execution" tone="emerald" />
          </div>

          {/* Opportunities by evidence class */}
          <EvidenceClassCard result={result} />

          {/* Top opportunities */}
          <TopOpportunitiesCard result={result} />

          {/* Caveats */}
          <CaveatsCard result={result} />

          {/* What this does NOT prove */}
          <DoesNotProveCard />
        </motion.div>
      )}
    </div>
  );
}

function SliderField({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-sm font-semibold tabular-nums">{format ? format(value) : value}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
    </div>
  );
}

function EvidenceLadderCard({ result }: { result: CapacityExperimentResult }) {
  const tiers = [
    { tier: "Tier A — Movement", value: result.totalMovements, label: "Observed movement (trips happened)", color: "bg-emerald-500", observed: true },
    { tier: "Tier B — Capacity", value: result.tierB_observedCapacity, label: "Observed spare capacity (passenger_count known)", color: "bg-cyan-500", observed: true },
    { tier: "Tier C — Capacity", value: result.tierC_inferredCapacity, label: "Inferred capacity (occupancy assumed)", color: "bg-amber-500", observed: false },
    { tier: "Tier D — Willingness", value: result.tierD_observedWillingness, label: "Observed willingness (acceptance measured)", color: "bg-violet-500", observed: true },
    { tier: "Tier E — Willingness", value: result.tierE_assumedWillingness, label: "Assumed willingness (modeled, not measured)", color: "bg-rose-500", observed: false },
  ];
  return (
    <Card className="overflow-hidden py-0">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500" />
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Evidence ladder — what is observed vs assumed</span>
      </div>
      <div className="divide-y">
        {tiers.map((t) => (
          <div key={t.tier} className="flex items-center gap-3 px-4 py-2.5">
            <div className="w-48 shrink-0">
              <Badge variant="outline" className={`text-[10px] ${t.observed ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-amber-500/40 text-amber-700 dark:text-amber-300"}`}>
                {t.observed ? "OBSERVED" : "ASSUMED"}
              </Badge>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">{t.tier}</p>
              <p className="text-[10px] text-muted-foreground">{t.label}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold tabular-nums">{t.value}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="border-t bg-rose-500/5 px-4 py-2">
        <p className="text-[10px] text-rose-700 dark:text-rose-300">
          <strong>Critical gap:</strong> Tier D (observed willingness) = 0. The marketplace thesis requires knowing whether movers will actually accept passengers. All 498 movements have Tier D = 0. This is the most important unvalidated assumption in the ORYXX thesis.
        </p>
      </div>
    </Card>
  );
}

function MetricCard({ icon: Icon, label, value, sub, tone }: { icon: any; label: string; value: string; sub: string; tone: "emerald" | "amber" }) {
  const color = tone === "emerald" ? "text-emerald-600" : "text-amber-600";
  return (
    <Card className="py-0">
      <div className="p-3">
        <div className="flex items-center gap-1.5"><Icon className={`h-3.5 w-3.5 ${color}`} /><span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span></div>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
        <p className="text-[10px] text-muted-foreground">{sub}</p>
      </div>
    </Card>
  );
}

function EvidenceClassCard({ result }: { result: CapacityExperimentResult }) {
  const o = result.opportunities;
  const total = o.fullEvidence + o.movementPlusCapacity + o.movementOnly + o.weak;
  const classes = [
    { label: "FULL-EVIDENCE (A+B+D observed)", count: o.fullEvidence, color: "bg-emerald-500", text: "text-emerald-600" },
    { label: "MOVEMENT+CAPACITY (A+B observed, E assumed)", count: o.movementPlusCapacity, color: "bg-cyan-500", text: "text-cyan-600" },
    { label: "MOVEMENT-ONLY (A observed, C+E assumed)", count: o.movementOnly, color: "bg-amber-500", text: "text-amber-600" },
    { label: "WEAK (all assumed)", count: o.weak, color: "bg-rose-500", text: "text-rose-600" },
  ];
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Opportunities by evidence class</span>
      </div>
      <div className="space-y-2 p-4">
        {classes.map((c) => (
          <div key={c.label} className="flex items-center gap-2">
            <span className="flex-1 text-[11px] text-muted-foreground">{c.label}</span>
            <div className="flex-1 h-5 rounded bg-muted overflow-hidden">
              <div className={`h-full ${c.color}`} style={{ width: `${total > 0 ? (c.count / total) * 100 : 0}%` }} />
            </div>
            <span className={`w-12 text-right text-[11px] font-medium ${c.text}`}>{c.count}</span>
          </div>
        ))}
      </div>
      <div className="border-t bg-muted/20 px-4 py-2 text-[10px] text-muted-foreground">
        Only FULL-EVIDENCE opportunities prove the marketplace thesis. MOVEMENT+CAPACITY proves spare capacity exists but not willingness. The current pilot has 0 FULL-EVIDENCE opportunities because willingness (Tier D) is never observed.
      </div>
    </Card>
  );
}

function TopOpportunitiesCard({ result }: { result: CapacityExperimentResult }) {
  if (result.topOpportunities.length === 0) {
    return (
      <Card className="py-0">
        <div className="border-b bg-muted/30 px-4 py-2.5"><span className="text-sm font-semibold">Top opportunities with evidence trail</span></div>
        <div className="p-6 text-center text-[11px] text-muted-foreground">No opportunities found.</div>
      </Card>
    );
  }
  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Top opportunities — each shows its evidence trail</span>
        <Badge variant="outline" className="text-[10px]">{result.topOpportunities.length} shown</Badge>
      </div>
      <ScrollArea className="max-h-96">
        <div className="space-y-2 p-3">
          {result.topOpportunities.map((o) => (
            <div key={o.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className={`text-[9px] ${o.evidenceScore.classification === "FULL-EVIDENCE" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : o.evidenceScore.classification === "MOVEMENT+CAPACITY" ? "border-cyan-500/40 text-cyan-700 dark:text-cyan-300" : "border-amber-500/40 text-amber-700 dark:text-amber-300"}`}>
                      {o.evidenceScore.classification}
                    </Badge>
                    <span className="text-xs font-medium">demand {o.demandId}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    {o.movement.originName} → {o.movement.destName} | passenger_count: <strong>{o.capacity.occupied.value}</strong> (OBSERVED) → spare: <strong>{o.capacity.spare.value}</strong> seats
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    willingness: {o.willingness.willingness.value} (ASSUMED) | execution: {o.willingness.executionProbability.value} (ASSUMED)
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-emerald-600">${o.estimatedUserSaving}</p>
                  <p className="text-[9px] text-muted-foreground">user saving</p>
                  <p className="text-[9px] text-muted-foreground">surplus ${o.estimatedSocialSurplus}</p>
                </div>
              </div>
              <Separator className="my-1.5" />
              <p className="text-[10px] italic text-amber-700 dark:text-amber-300">⚠ {o.reasonOrdinaryWouldMiss}</p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
}

function CaveatsCard({ result }: { result: CapacityExperimentResult }) {
  return (
    <Card className="py-0 border-amber-500/30">
      <div className="border-b bg-amber-500/5 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-200"><AlertTriangle className="h-4 w-4" /> Caveats — what this data can and cannot tell us</span>
      </div>
      <div className="divide-y">
        {result.caveats.map((w, i) => (
          <div key={i} className="px-4 py-2 text-[11px] text-muted-foreground">· {w}</div>
        ))}
      </div>
    </Card>
  );
}

function DoesNotProveCard() {
  return (
    <Card className="py-0 border-rose-500/30">
      <div className="border-b bg-rose-500/5 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-rose-800 dark:text-rose-200"><ShieldAlert className="h-4 w-4" /> What this experiment does NOT prove</span>
      </div>
      <div className="space-y-1.5 px-4 py-3 text-[11px] text-muted-foreground">
        <p>· It proves that real taxi trips had OBSERVED spare seats (passenger_count &lt; 4). It does <strong>NOT</strong> prove those seats were available to ORYXX — the taxi was on a dispatched trip.</p>
        <p>· It does <strong>NOT</strong> prove that taxi drivers would accept a pooled passenger. Willingness is 100% assumed (Tier E).</p>
        <p>· It does <strong>NOT</strong> prove the marketplace thesis — that requires Tier D (observed willingness), which this dataset cannot provide.</p>
        <p>· It does <strong>NOT</strong> generalize — 500 trips from one evening in one city is a methodology demonstration, not a population statistic.</p>
        <p className="pt-1 font-medium text-foreground">The defensible claim: "Real taxi data shows OBSERVED spare capacity exists (479/498 trips had empty seats). Whether that capacity can be monetized requires a willingness experiment — the single most important next step."</p>
      </div>
    </Card>
  );
}
