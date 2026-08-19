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
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  BarChart, Bar,
} from "recharts";
import {
  Play, Loader2, Globe, AlertTriangle, Sparkles, MapPin, Clock, Activity,
  Database, ShieldAlert, Info, CheckCircle2, Route, TrendingUp,
} from "lucide-react";
import type { OpportunityExperimentResult } from "@/lib/oryxx/real/types";

export function RealLab() {
  const { toast } = useToast();
  const [numDemands, setNumDemands] = useState(200);
  const [movementDensity, setMovementDensity] = useState(1.0);
  const [willingness, setWillingness] = useState(0.5);
  const [detourTolerance, setDetourTolerance] = useState(2.0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OpportunityExperimentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oryxx/opportunity/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          numDemands, movementDensity, willingness,
          detourToleranceKm: detourTolerance, seed: 42, planningHorizonSec: 0,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data: OpportunityExperimentResult = await res.json();
      setResult(data);
      toast({
        title: "Opportunity experiment complete",
        description: `${data.opportunities.length} opportunities from ${data.movements.length} movements · ${data.metrics.opportunitiesPer1000}/1000`,
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
              <Globe className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Real-World Opportunity Lab</p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Does real-shaped movement data contain latent supply ordinary routing misses?
              </p>
            </div>
          </div>
          <Button size="sm" onClick={run} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700">
            {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…</>
                   : <><Play className="mr-2 h-4 w-4" /> Run experiment</>}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <SliderField label="Demands" value={numDemands} min={50} max={1000} step={50} onChange={setNumDemands} hint="transportation events" />
          <SliderField label="Movement density" value={movementDensity} min={0.25} max={4} step={0.25} onChange={setMovementDensity} hint="× baseline trajectories" format={(v) => `${v}x`} />
          <SliderField label="Willingness (assumed)" value={willingness} min={0.1} max={1} step={0.05} onChange={setWillingness} hint="mover acceptance probability" format={(v) => `${Math.round(v * 100)}%`} />
          <SliderField label="Detour tolerance (assumed)" value={detourTolerance} min={0.5} max={6} step={0.5} onChange={setDetourTolerance} hint="km a mover will divert" format={(v) => `${v}km`} />
        </div>
      </Card>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-2 text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {result && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-6">
          <PilotCard result={result} />
          <HeadlineMetrics result={result} />
          <ValueSplitCard result={result} />
          <PlanningHorizonCard result={result} />
          <DensityCard result={result} />
          <OpportunitiesFeed result={result} />
          <AssumptionsCard result={result} />
          <WarningsCard result={result} />
          <DoesNotProveCard />
        </motion.div>
      )}
    </div>
  );
}

function SliderField({ label, value, min, max, step, onChange, hint, format }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint?: string; format?: (v: number) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-sm font-semibold tabular-nums">{format ? format(value) : value}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PilotCard({ result }: { result: OpportunityExperimentResult }) {
  const p = result.pilot;
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Pilot geography & data sources</span>
      </div>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium"><MapPin className="h-3.5 w-3.5 text-emerald-600" /> {p.name}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{p.description}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">bbox: {p.bbox.minLat.toFixed(3)}, {p.bbox.minLon.toFixed(3)} → {p.bbox.maxLat.toFixed(3)}, {p.bbox.maxLon.toFixed(3)}</p>
        </div>
        <div>
          {result.datasets.map((ds, i) => (
            <div key={i} className="mb-1.5 rounded-md border bg-muted/20 p-2">
              <div className="flex items-center gap-1.5">
                <Database className="h-3 w-3 text-muted-foreground" />
                <span className="text-[11px] font-medium">{ds.name}</span>
                {ds.isFixture && <Badge variant="outline" className="border-amber-500/40 text-[9px] text-amber-700 dark:text-amber-300">FIXTURE</Badge>}
              </div>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{ds.license}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t bg-amber-500/5 px-4 py-2">
        <p className="text-[10px] font-medium text-amber-700 dark:text-amber-300">Known limitations:</p>
        <ul className="mt-0.5 space-y-0.5">
          {p.knownLimitations.slice(0, 3).map((l, i) => (
            <li key={i} className="text-[10px] text-muted-foreground">· {l}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function HeadlineMetrics({ result }: { result: OpportunityExperimentResult }) {
  const m = result.metrics;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <MetricCard icon={Activity} label="Opportunities / 1000 demands" value={String(m.opportunitiesPer1000)} sub={`${m.feasibleOpportunities} feasible`} tone="emerald" />
      <MetricCard icon={Sparkles} label="Economically attractive" value={String(m.economicallyAttractive)} sub="tier ≥ 2" tone="emerald" />
      <MetricCard icon={CheckCircle2} label="High confidence" value={String(m.highConfidence)} sub="confidence ≥ 0.6" tone="amber" />
      <MetricCard icon={TrendingUp} label="Total estimated value" value={`$${m.totalEstimatedValue}`} sub={`median $${m.medianValue}`} tone="emerald" />
    </div>
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

function ValueSplitCard({ result }: { result: OpportunityExperimentResult }) {
  const m = result.metrics;
  const total = m.multimodalRoutingValue + m.latentSupplyDiscoveryValue;
  const latentPct = total > 0 ? Math.round((m.latentSupplyDiscoveryValue / total) * 100) : 0;
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Critical split: multimodal routing value vs latent-supply discovery value</span>
      </div>
      <div className="p-4">
        <div className="flex h-6 overflow-hidden rounded-full">
          <div className="bg-cyan-500" style={{ width: `${100 - latentPct}%` }} title="multimodal routing" />
          <div className="bg-emerald-500" style={{ width: `${latentPct}%` }} title="latent supply discovery" />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-cyan-500" /> Multimodal: <strong>${m.multimodalRoutingValue}</strong></span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Latent discovery: <strong>${m.latentSupplyDiscoveryValue}</strong> ({latentPct}%)</span>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Only the <strong className="text-emerald-600">latent-supply discovery</strong> portion requires info ordinary routing lacks (observed movement). The multimodal portion is value a competent transit-aware planner would already capture.
        </p>
      </div>
    </Card>
  );
}

function PlanningHorizonCard({ result }: { result: OpportunityExperimentResult }) {
  const data = result.planningHorizonCurve.map((p) => ({
    horizon: p.horizonSec === 0 ? "0" : p.horizonSec < 3600 ? `${p.horizonSec / 60}m` : p.horizonSec < 86400 ? `${Math.round(p.horizonSec / 3600)}h` : `${Math.round(p.horizonSec / 86400)}d`,
    opportunities: p.opportunities, value: p.value,
  }));
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Planning-horizon curve — does future visibility create more opportunities?</span>
      </div>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
            <XAxis dataKey="horizon" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="opportunities" stroke="#10b981" strokeWidth={2} name="Opportunities" />
            <Line type="monotone" dataKey="value" stroke="#0ea5e9" strokeWidth={2} name="Value ($)" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function DensityCard({ result }: { result: OpportunityExperimentResult }) {
  const data = result.densityCurve.map((p) => ({ density: `${p.density}x`, opportunities: p.opportunities, value: p.value }));
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Density curve — does opportunity count grow superlinearly with movement density?</span>
      </div>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
            <XAxis dataKey="density" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="opportunities" fill="#10b981" radius={[3, 3, 0, 0]} name="Opportunities" />
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-1 text-[10px] text-muted-foreground">If bars curve upward superlinearly → network effect. If proportional → linear. If flattening → saturating.</p>
      </div>
    </Card>
  );
}

function OpportunitiesFeed({ result }: { result: OpportunityExperimentResult }) {
  if (result.topOpportunities.length === 0) {
    return (
      <Card className="py-0">
        <div className="border-b bg-muted/30 px-4 py-2.5"><span className="text-sm font-semibold">ORYXX moments — why ordinary routing missed each</span></div>
        <div className="p-6 text-center text-[11px] text-muted-foreground">No opportunities discovered in this configuration.</div>
      </Card>
    );
  }
  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">ORYXX moments — why ordinary routing missed each</span>
        <Badge variant="outline" className="text-[10px]">{result.topOpportunities.length} shown</Badge>
      </div>
      <ScrollArea className="max-h-96">
        <div className="space-y-2 p-3">
          {result.topOpportunities.map((o) => (
            <div key={o.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[9px]">T{o.tier}</Badge>
                    <span className="text-xs font-medium">demand {o.demandId}</span>
                    <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">latent supply</Badge>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{o.reasonOrdinaryWouldMiss}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground line-through">${o.baselineCost} ({o.baselineMode})</span>
                    <span className="font-bold text-emerald-600">${o.opportunityCost}</span>
                  </div>
                  <p className="text-[10px] text-emerald-600">save ${o.estimatedUserSaving} · surplus ${o.estimatedSocialSurplus}</p>
                  <p className="text-[9px] text-muted-foreground">confidence {Math.round(o.confidence.overall * 100)}%</p>
                </div>
              </div>
              <Separator className="my-2" />
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                <span><Clock className="mr-0.5 inline h-2.5 w-2.5" />depart {secToHHMM(o.departureSec)}</span>
                <span><Route className="mr-0.5 inline h-2.5 w-2.5" />detour {o.detourKm}km</span>
                <span><Activity className="mr-0.5 inline h-2.5 w-2.5" />exec prob {Math.round(o.executionProbability * 100)}%</span>
              </div>
              <p className="mt-1 text-[9px] italic text-amber-700 dark:text-amber-300">⚠ {o.assumptionSummary}</p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
}

function AssumptionsCard({ result }: { result: OpportunityExperimentResult }) {
  return (
    <Card className="py-0">
      <div className="border-b bg-amber-500/5 px-4 py-2.5">
        <span className="text-sm font-semibold text-amber-800 dark:text-amber-200">Assumptions (scenario parameters, NOT observations)</span>
      </div>
      <div className="divide-y">
        {result.assumptions.map((a, i) => (
          <div key={i} className="px-4 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium font-mono">{a.name}</span>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[9px]">{a.value}</Badge>
                <Badge variant="outline" className={`text-[9px] ${a.sensitivity === "high" ? "border-rose-500/40 text-rose-600" : a.sensitivity === "medium" ? "border-amber-500/40 text-amber-600" : ""}`}>{a.sensitivity} sensitivity</Badge>
              </div>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{a.rationale}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function WarningsCard({ result }: { result: OpportunityExperimentResult }) {
  return (
    <Card className="py-0 border-amber-500/30">
      <div className="border-b bg-amber-500/5 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-200"><AlertTriangle className="h-4 w-4" /> Data quality warnings</span>
      </div>
      <div className="divide-y">
        {result.dataQualityWarnings.map((w, i) => (
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
        <p>· It does <strong>not</strong> prove real-world latent supply exists at this density. Movement data is fixture/synthetic.</p>
        <p>· It does <strong>not</strong> prove movers would accept passengers. Willingness is assumed, not measured.</p>
        <p>· It does <strong>not</strong> prove execution reliability. Execution probability is assumed.</p>
        <p>· It does <strong>not</strong> prove the opportunities are bookable. No provider integration exists.</p>
        <p>· It does <strong>not</strong> prove the thesis survives contact with real data — only that the <em>mechanism</em> works on real-shaped data.</p>
        <p className="pt-1 font-medium text-foreground">Defensible claim: "ORYXX's opportunity engine can discover latent-supply matches from movement data that ordinary multimodal routing structurally cannot see." Whether real movement data contains enough such opportunities is the next experiment.</p>
      </div>
    </Card>
  );
}

function secToHHMM(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
