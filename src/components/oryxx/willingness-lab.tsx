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
  Play, Loader2, ShieldAlert, AlertTriangle, Info, CheckCircle2, XCircle,
  TrendingDown, TrendingUp, Filter, DollarSign, Route, Clock, Bell,
} from "lucide-react";
import type { WillingnessExperimentResult } from "@/lib/oryxx/real/evidence/willingness";
import { WILLINGNESS_TIERS } from "@/lib/oryxx/real/evidence/willingness";

export function WillingnessLab() {
  const { toast } = useToast();
  const [numDemands, setNumDemands] = useState(150);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WillingnessExperimentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oryxx/willingness/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numDemands, seed: 42 }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data: WillingnessExperimentResult = await res.json();
      setResult(data);
      toast({
        title: "Willingness experiment complete",
        description: `Evidence tier: ${data.evidenceTier} | ${data.totalObservations} observations | ${data.funnel.finalExecutedPer1000} executed/1000`,
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
              <Filter className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Willingness Evidence Lab</p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Has ORYXX crossed the gap from capacity to bookable supply?
              </p>
            </div>
          </div>
          <Button size="sm" onClick={run} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700">
            {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…</>
                   : <><Play className="mr-2 h-4 w-4" /> Run scenario analysis</>}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <SliderField label="Demands" value={numDemands} min={50} max={500} step={50} onChange={setNumDemands} />
        </div>
        <div className="border-t bg-amber-500/5 px-4 py-2">
          <p className="text-[10px] text-amber-700 dark:text-amber-300">
            <strong>SCENARIO ANALYSIS</strong> — The acceptance model below is a SCENARIO ESTIMATE from W2a (not-on-trip) observations + behavioral assumptions. It is NOT observed acceptance (W3). No public W3 dataset exists. A field experiment is instrumented to collect W3 evidence — see the field-experiment API at /api/oryxx/willingness/experiment.
          </p>
        </div>
      </Card>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-2 text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {result && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-6">
          <EvidenceTierCard result={result} />
          <FunnelCard result={result} />
          <AcceptanceCurvesCard result={result} />
          <BreakEvenCard result={result} />
          <EconomicMetricsCard result={result} />
          <ObservedVsAssumedCard result={result} />
          <BiasesCard result={result} />
          <W3PilotStatusCard />
          <DoesNotProveCard result={result} />
        </motion.div>
      )}
    </div>
  );
}

function SliderField({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
    </div>
  );
}

function EvidenceTierCard({ result }: { result: WillingnessExperimentResult }) {
  return (
    <Card className="overflow-hidden py-0">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-rose-500 via-amber-500 to-emerald-500" />
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Evidence tier achieved</span>
      </div>
      <div className="divide-y">
        {WILLINGNESS_TIERS.map((t) => {
          const isCurrent = t.tier === result.evidenceTier;
          return (
            <div key={t.tier} className={`flex items-center gap-3 px-4 py-2.5 ${isCurrent ? "bg-emerald-500/5" : ""}`}>
              <div className="w-12 shrink-0">
                <Badge variant="outline" className={`text-[10px] ${isCurrent ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : t.strength >= 3 ? "border-violet-500/40 text-violet-700 dark:text-violet-300" : "text-muted-foreground"}`}>
                  {t.tier}
                </Badge>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">{t.name}</p>
                <p className="text-[10px] text-muted-foreground">{t.description}</p>
              </div>
              <div className="text-right shrink-0">
                {isCurrent ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : t.marketplaceSufficient ? <Info className="h-4 w-4 text-violet-400" /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className={`border-t px-4 py-2 ${result.marketplaceSufficient ? "bg-emerald-500/5" : "bg-rose-500/5"}`}>
        <p className={`text-[11px] font-medium ${result.marketplaceSufficient ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
          {result.marketplaceSufficient
            ? `Evidence tier ${result.evidenceTier} is SUFFICIENT to justify marketplace investment.`
            : `Evidence tier ${result.evidenceTier} (${result.evidenceTierName}) is NOT SUFFICIENT. The marketplace thesis requires W3 (revealed acceptance of a real offer). Current evidence is W2a (not-on-trip observation) — it does NOT prove drivers were available or willing.`}
        </p>
      </div>
    </Card>
  );
}

function FunnelCard({ result }: { result: WillingnessExperimentResult }) {
  const f = result.funnel;
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Opportunity funnel — from movement to executed opportunity</span>
      </div>
      <div className="p-4">
        {f.steps.map((s, i) => (
          <div key={i} className="mb-2">
            <div className="flex items-center justify-between text-[11px] mb-0.5">
              <span className="text-muted-foreground">{s.step}</span>
              <span className="font-medium tabular-nums">{s.count} ({s.pctOfTotal}%)</span>
            </div>
            <div className="h-4 rounded bg-muted overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${s.pctOfTotal}%` }} />
            </div>
            {i < f.steps.length - 1 && s.pctOfPrevious < 50 && (
              <p className="text-[9px] text-rose-500 mt-0.5">↓ {s.pctOfPrevious}% of previous step</p>
            )}
          </div>
        ))}
        <div className="mt-2 rounded border bg-emerald-500/5 px-3 py-2">
          <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            Expected executed opportunities: {f.finalExecutedOpportunities} ({f.finalExecutedPer1000} per 1000 demands)
          </p>
        </div>
      </div>
    </Card>
  );
}

function AcceptanceCurvesCard({ result }: { result: WillingnessExperimentResult }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <CurveCard title="Acceptance vs compensation" icon={DollarSign} data={result.acceptanceVsCompensation} xKey="compensation" xLabel="$" />
      <CurveCard title="Acceptance vs detour" icon={Route} data={result.acceptanceVsDetour} xKey="detourKm" xLabel="km" />
      <CurveCard title="Acceptance vs extra time" icon={Clock} data={result.acceptanceVsTime} xKey="extraTimeMin" xLabel="min" />
      <CurveCard title="Acceptance vs advance notice" icon={Bell} data={result.acceptanceVsNotice} xKey="noticeMin" xLabel="min" />
    </div>
  );
}

function CurveCard({ title, icon: Icon, data, xKey, xLabel }: { title: string; icon: any; data: any[]; xKey: string; xLabel: string }) {
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold"><Icon className="h-3.5 w-3.5 text-emerald-600" /> {title}</span>
      </div>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} label={{ value: xLabel, position: "insideBottom", offset: -2, style: { fontSize: 9 } }} />
            <YAxis tick={{ fontSize: 10 }} domain={[0, 1]} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Line type="monotone" dataKey="pAccept" stroke="#10b981" strokeWidth={2} name="P(accept)" />
            <Line type="monotone" dataKey="ciLow" stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" name="CI low" />
            <Line type="monotone" dataKey="ciHigh" stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" name="CI high" />
          </LineChart>
        </ResponsiveContainer>
        <p className="mt-1 text-[9px] text-rose-500 font-medium">⚠ SCENARIO MODEL — NOT OBSERVED. W2a not-on-trip proxy, NOT W3 revealed acceptance.</p>
      </div>
    </Card>
  );
}

function BreakEvenCard({ result }: { result: WillingnessExperimentResult }) {
  const data = result.breakEven.map((b) => ({
    detour: `${b.detourKm}km`,
    breakEven: b.minAcceptanceForBreakEven * 100,
    current: b.currentEstimatedAcceptance * 100,
    viable: b.isViable,
  }));
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Break-even analysis — is acceptance high enough to be economic?</span>
      </div>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
            <XAxis dataKey="detour" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} label={{ value: "%", angle: -90, position: "insideLeft", style: { fontSize: 9 } }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="breakEven" fill="#f43f5e" radius={[3, 3, 0, 0]} name="Break-even %" />
            <Bar dataKey="current" fill="#10b981" radius={[3, 3, 0, 0]} name="Current P(accept) %" />
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Break-even = the minimum acceptance rate for user savings to exceed supplier compensation + failure cost.
          {result.breakEven.filter(b => b.isViable).length > 0
            ? ` ${result.breakEven.filter(b => b.isViable).length} detour levels are viable.`
            : " NO detour levels are viable at current acceptance — the marketplace economics are marginal."}
        </p>
      </div>
    </Card>
  );
}

function EconomicMetricsCard({ result }: { result: WillingnessExperimentResult }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <MetricCard label="Executed / 1000" value={String(result.expectedExecutedPer1000)} tone="emerald" />
      <MetricCard label="User savings / 1000" value={`$${result.expectedUserSavingsPer1000}`} tone="emerald" />
      <MetricCard label="Supplier earnings / 1000" value={`$${result.expectedSupplierEarningsPer1000}`} tone="cyan" />
      <MetricCard label="Net value / 1000" value={`$${result.netEconomicValuePer1000}`} tone={result.netEconomicValuePer1000 > 0 ? "emerald" : "rose"} />
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: "emerald" | "rose" | "cyan" }) {
  const color = { emerald: "text-emerald-600", rose: "text-rose-600", cyan: "text-cyan-600" }[tone];
  return (
    <Card className="py-0">
      <div className="p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      </div>
    </Card>
  );
}

function ObservedVsAssumedCard({ result }: { result: WillingnessExperimentResult }) {
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5"><span className="text-sm font-semibold">What is observed vs assumed</span></div>
      <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
        <div>
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300 mb-1">OBSERVED</Badge>
          <ul className="space-y-0.5">
            {result.whatIsObserved.map((o, i) => <li key={i} className="text-[11px] text-muted-foreground">· {o}</li>)}
          </ul>
        </div>
        <div>
          <Badge variant="outline" className="border-rose-500/40 text-rose-700 dark:text-rose-300 mb-1">ASSUMED</Badge>
          <ul className="space-y-0.5">
            {result.whatIsAssumed.map((a, i) => <li key={i} className="text-[11px] text-muted-foreground">· {a}</li>)}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function BiasesCard({ result }: { result: WillingnessExperimentResult }) {
  return (
    <Card className="py-0 border-amber-500/30">
      <div className="border-b bg-amber-500/5 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-200"><AlertTriangle className="h-4 w-4" /> Sampling biases</span>
      </div>
      <div className="divide-y">
        {result.biases.map((b, i) => <div key={i} className="px-4 py-2 text-[11px] text-muted-foreground">· {b}</div>)}
      </div>
    </Card>
  );
}

function DoesNotProveCard({ result }: { result: WillingnessExperimentResult }) {
  return (
    <Card className="py-0 border-rose-500/30">
      <div className="border-t bg-rose-500/5 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-rose-800 dark:text-rose-200"><ShieldAlert className="h-4 w-4" /> What this does NOT prove</span>
      </div>
      <div className="space-y-1.5 px-4 py-3 text-[11px] text-muted-foreground">
        <p>· It does <strong>NOT</strong> prove drivers would accept pooled passengers. W2a shows not-on-trip intervals, not acceptance.</p>
        <p>· It does <strong>NOT</strong> prove the marketplace is economically viable. Break-even shows ~100% acceptance needed at $3 comp.</p>
        <p>· It does <strong>NOT</strong> prove execution reliability. Execution (70%) and completion (85%) rates are assumed.</p>
        <p className="pt-1 font-medium text-foreground">
          The single missing measurement: W3 (revealed acceptance) — present a real pooled-trip offer to real drivers and record accept/decline. The field-experiment API is instrumented at /api/oryxx/willingness/experiment. Without W3, the marketplace thesis is not justified.
        </p>
      </div>
    </Card>
  );
}

function W3PilotStatusCard() {
  return (
    <Card className="py-0 border-violet-500/30">
      <div className="border-t bg-violet-500/5 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-violet-800 dark:text-violet-200">
          <Info className="h-4 w-4" /> W3 Pilot — field-experiment instrumentation status
        </span>
      </div>
      <div className="space-y-2 px-4 py-3 text-[11px] text-muted-foreground">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">State machine</p>
            <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">IMPLEMENTED</Badge>
            <p className="mt-0.5 text-[9px]">OFFER_CREATED → PRESENTED → VIEWED → ACCEPTED → COMPLETED</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Preregistration</p>
            <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">IMPLEMENTED</Badge>
            <p className="mt-0.5 text-[9px]">Immutable spec: hypothesis, design, stopping rule</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Randomization</p>
            <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">IMPLEMENTED</Badge>
            <p className="mt-0.5 text-[9px]">Deterministic treatment assignment (balanced)</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Safety validator</p>
            <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">IMPLEMENTED</Badge>
            <p className="mt-0.5 text-[9px]">max detour, max time, min comp enforced</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Sample-size calc</p>
            <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">IMPLEMENTED</Badge>
            <p className="mt-0.5 text-[9px]">Two-proportion z-test, alpha=0.05, power=0.80</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Marketplace decision</p>
            <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">IMPLEMENTED</Badge>
            <p className="mt-0.5 text-[9px]">Per-cell break-even + viability check</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">W3 evidence</p>
            <Badge variant="outline" className="border-rose-500/40 text-[9px] text-rose-700 dark:text-rose-300">ZERO</Badge>
            <p className="mt-0.5 text-[9px]">No provider has accepted a real offer</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">W4 evidence</p>
            <Badge variant="outline" className="border-rose-500/40 text-[9px] text-rose-700 dark:text-rose-300">ZERO</Badge>
            <p className="mt-0.5 text-[9px]">No pooled trip has been completed</p>
          </div>
        </div>
        <Separator className="my-2" />
        <div className="rounded bg-amber-500/5 px-3 py-2">
          <p className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
            PILOT STATUS: PREREGISTERED — NOT ACTIVE
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            The experiment is instrumented and ready to deploy but has NOT been activated. No real providers have been contacted.
            Activation requires explicit external authorization + ethical review. The API endpoints at
            <code className="mx-1 rounded bg-muted px-1">/api/oryxx/willingness/experiment</code>
            <code className="mx-1 rounded bg-muted px-1">/api/oryxx/willingness/response</code>
            <code className="mx-1 rounded bg-muted px-1">/api/oryxx/willingness/results</code>
            implement the full state machine.
          </p>
        </div>
        <div className="mt-2 rounded bg-muted/30 px-3 py-2">
          <p className="text-[10px] font-medium text-foreground">Evidence integrity guarantees:</p>
          <ul className="mt-1 space-y-0.5">
            <li className="text-[10px]">· Only PROVIDER_ACCEPTED state can create W3 evidence (state machine enforced)</li>
            <li className="text-[10px]">· Only TRIP_COMPLETED state can create W4 evidence</li>
            <li className="text-[10px]">· W2a observations CANNOT transition to W3 without a real provider decision</li>
            <li className="text-[10px]">· Invalid state transitions are rejected by the API</li>
            <li className="text-[10px]">· Provider IDs are pseudonymous (random hex, no PII)</li>
            <li className="text-[10px]">· Unsafe offers are rejected before presentation (max detour, max time, min comp)</li>
            <li className="text-[10px]">· Preregistration is immutable once experiment is active</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
