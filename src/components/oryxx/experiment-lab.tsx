"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  LineChart, Line, ErrorBar,
} from "recharts";
import {
  Play, Loader2, FlaskConical, AlertTriangle, TrendingDown, TrendingUp,
  CheckCircle2, XCircle, Beaker, Gauge, Sparkles, Info, ShieldCheck, Activity,
} from "lucide-react";
import type { ExperimentResult } from "@/lib/oryxx/market/canonical/types";
import { REGIMES } from "@/lib/oryxx/market/experiment/regimes";
import { STRATEGIES } from "@/lib/oryxx/market/canonical/types";

const METRIC_LABELS: Record<string, string> = {
  matchingRate: "Matching rate",
  totalRiskAdjustedWelfare: "Risk-adj. welfare",
  totalSocialSurplus: "Social surplus",
  totalUserCost: "User cost",
  emptyVehicleKm: "Empty vehicle-km",
  seatUtilization: "Seat utilization",
  avgTravelTimeMin: "Avg travel time",
  avgDetourKm: "Avg detour",
  unservedDemandValue: "Unserved value",
  matchedDemands: "Matched demands",
};

const STRAT_COLOR: Record<string, string> = Object.fromEntries(STRATEGIES.map((s) => [s.id, s.color]));

export function ExperimentLab() {
  const { toast } = useToast();
  const [regimeId, setRegimeId] = useState("balanced");
  const [numSeeds, setNumSeeds] = useState(20);
  const [numDemands, setNumDemands] = useState(60);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeMetric, setActiveMetric] = useState("totalRiskAdjustedWelfare");

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oryxx/experiment/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regime: regimeId, numSeeds, config: { numDemands } }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data: ExperimentResult = await res.json();
      setResult(data);
      toast({
        title: "Experiment complete",
        description: `${data.runs.length} seeds × ${data.config.strategies.length} strategies · ${data.failureCases.length} failure cases`,
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? "Unknown error";
      setError(msg);
      toast({ title: "Experiment failed", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const strategyIds = result?.config.strategies ?? ["ordinary", "multimodal", "pooling-fixed", "centralized", "oryxx", "clairvoyant"];

  return (
    <div className="space-y-6">
      {/* Configurator */}
      <Card className="py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white">
              <FlaskConical className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Experiment Lab</p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Multi-seed · 6 strategies · advantage decomposition · falsifiable
              </p>
            </div>
          </div>
          <Button size="sm" onClick={run} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700">
            {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…</>
                   : <><Play className="mr-2 h-4 w-4" /> Run experiment</>}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-1">
            <Label className="text-xs text-muted-foreground">Market regime</Label>
            <Select value={regimeId} onValueChange={setRegimeId}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REGIMES.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">{REGIMES.find((r) => r.id === regimeId)?.description}</p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Seeds</Label>
              <span className="text-sm font-semibold tabular-nums">{numSeeds}</span>
            </div>
            <Slider value={[numSeeds]} min={5} max={100} step={5} onValueChange={(v) => setNumSeeds(v[0])} />
            <p className="text-[10px] text-muted-foreground">Each seed = same generated world evaluated by all strategies</p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Demands per seed</Label>
              <span className="text-sm font-semibold tabular-nums">{numDemands}</span>
            </div>
            <Slider value={[numDemands]} min={10} max={300} step={10} onValueChange={(v) => setNumDemands(v[0])} />
            <p className="text-[10px] text-muted-foreground">≤16 enables exact B&B solver (clairvoyant)</p>
          </div>
        </div>
      </Card>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-2 text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {result && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-6">
          {/* Invariant status */}
          <InvariantBanner result={result} />

          {/* ORYXX Moments — the clean thesis metric */}
          <OryxMomentsBanner result={result} />

          {/* Advantage decomposition ladder */}
          <DecompositionLadder result={result} />

          {/* Headline paired diffs */}
          <HeadlinePairedDiffs result={result} />

          {/* Distribution chart */}
          <DistributionChart result={result} activeMetric={activeMetric} setActiveMetric={setActiveMetric} />

          {/* Paired comparison table */}
          <PairedDiffTable result={result} />

          {/* Strategies table */}
          <StrategiesTable result={result} strategyIds={strategyIds} />

          {/* ORYXX moments */}
          <OpportunitiesFeed result={result} />

          {/* Where ORYXX loses */}
          <FailureCases result={result} />

          {/* Methodology */}
          <MethodologyPanel result={result} />
        </motion.div>
      )}
    </div>
  );
}

function InvariantBanner({ result }: { result: ExperimentResult }) {
  const totalSeeds = result.runs.length;
  const passedSeeds = result.runs.filter((r) => r.invariantsPassed).length;
  const allPassed = passedSeeds === totalSeeds;
  return (
    <Card className={`py-0 ${allPassed ? "border-emerald-500/40" : "border-rose-500/40"}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {allPassed ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <XCircle className="h-5 w-5 text-rose-600" />}
        <div className="flex-1">
          <p className="text-sm font-semibold">
            Fairness invariants: {passedSeeds}/{totalSeeds} seeds passed
          </p>
          <p className="text-[11px] text-muted-foreground">
            Identical demands/supplies across strategies · shared feasibility · welfare = value − cost (price transfers cannot create welfare) · no double-matching · no capacity violations
          </p>
        </div>
        <Badge variant="outline" className={allPassed ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-rose-500/40 text-rose-700 dark:text-rose-300"}>
          {allPassed ? "FAIR" : "VIOLATED"}
        </Badge>
      </div>
    </Card>
  );
}

function OryxMomentsBanner({ result }: { result: ExperimentResult }) {
  const m = result.oryxxMomentsStats;
  return (
    <Card className="overflow-hidden py-0">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500" />
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <div className="border-b border-r p-4 sm:border-r sm:border-b-0">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">ORYXX moments per seed</span>
          </div>
          <p className="mt-1 text-3xl font-bold tabular-nums text-emerald-600">{m.mean.toFixed(1)}</p>
          <p className="text-[11px] text-muted-foreground">median {m.median} · p10–p90: {m.p10}–{m.p90}</p>
        </div>
        <div className="border-b border-r p-4 sm:border-b-0">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Total opportunities discovered</span>
          </div>
          <p className="mt-1 text-3xl font-bold tabular-nums text-emerald-600">{m.totalAcrossSeeds}</p>
          <p className="text-[11px] text-muted-foreground">across {result.runs.length} seeds</p>
        </div>
        <div className="p-4">
          <div className="flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">What this means</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Feasible (demand, supply) matches using transit, carpool NPDs, or truck backhauls —
            invisible to ordinary routing. This is the clean thesis test:
            <strong className="text-foreground"> does ORYXX discover opportunities incumbents cannot see?</strong>
          </p>
        </div>
      </div>
    </Card>
  );
}

function DecompositionLadder({ result }: { result: ExperimentResult }) {
  if (!result.decomposition || result.decomposition.length === 0) return null;
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Advantage decomposition — what actually creates the value?</span>
          <Badge variant="outline" className="text-[10px]">A → B → C → D → E → F</Badge>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Each row isolates one mechanism's marginal contribution to risk-adjusted welfare. Mean Δ and win rate across {result.runs.length} seeds.
        </p>
      </div>
      <div className="divide-y">
        {result.decomposition.map((d) => {
          const isPositive = d.mean > 0.5;
          const isZero = Math.abs(d.mean) < 0.5;
          const tone = isZero ? "amber" : isPositive ? "emerald" : "rose";
          const color = tone === "emerald" ? "text-emerald-600" : tone === "rose" ? "text-rose-600" : "text-amber-600";
          const bgColor = tone === "emerald" ? "bg-emerald-500/5" : tone === "rose" ? "bg-rose-500/5" : "bg-amber-500/5";
          return (
            <div key={d.comparison} className={`flex items-center gap-3 px-4 py-3 ${bgColor}`}>
              <div className="w-16 shrink-0">
                <Badge variant="outline" className="font-mono text-[11px]">{d.comparison}</Badge>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{d.label}</p>
                <p className="text-[11px] text-muted-foreground">
                  win rate {(d.winRate * 100).toFixed(0)}% · p10–p90: {d.p10.toFixed(1)} to {d.p90.toFixed(1)}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-lg font-bold tabular-nums ${color}`}>
                  {d.mean > 0 ? "+" : ""}{d.mean.toFixed(1)}
                </p>
                {isZero && (
                  <p className="text-[10px] text-amber-600">≈ zero</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t bg-muted/20 px-4 py-2 text-[10px] leading-relaxed text-muted-foreground">
        <strong className="text-foreground">How to read this:</strong> B−A measures the value of multimodal routing (seeing transit/carpool/truck but not sharing). C−B measures physical coordination (sharing capacity). D−C measures negotiated pricing. E−D measures ORYXX's market mechanism. F−E is the optimization gap. If a row is ≈ zero, that mechanism adds no measurable value in this regime.
      </div>
    </Card>
  );
}

function HeadlinePairedDiffs({ result }: { result: ExperimentResult }) {
  const welfareDiff = result.pairedDiffs.find((p) => p.comparison === "oryxx - ordinary" && p.metric === "totalRiskAdjustedWelfare");
  const emptyKmDiff = result.pairedDiffs.find((p) => p.comparison === "oryxx - ordinary" && p.metric === "emptyVehicleKm");
  const matchRateDiff = result.pairedDiffs.find((p) => p.comparison === "oryxx - ordinary" && p.metric === "matchingRate");
  const clairvoyantGap = result.pairedDiffs.find((p) => p.comparison === "clairvoyant - oryxx" && p.metric === "totalRiskAdjustedWelfare");

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <HeadlineCard
        icon={welfareDiff && welfareDiff.mean > 0 ? TrendingUp : TrendingDown}
        label="ORYXX welfare vs ordinary"
        value={welfareDiff ? `${welfareDiff.mean > 0 ? "+" : ""}${welfareDiff.mean.toFixed(1)}` : "—"}
        sub={welfareDiff ? `win rate ${(welfareDiff.winRate * 100).toFixed(0)}% (${welfareDiff.leftWins}/${welfareDiff.n})` : ""}
        tone={welfareDiff && welfareDiff.mean > 0 ? "emerald" : "rose"}
      />
      <HeadlineCard
        icon={emptyKmDiff && emptyKmDiff.mean < 0 ? TrendingDown : TrendingUp}
        label="Empty vehicle-km vs ordinary"
        value={emptyKmDiff ? `${emptyKmDiff.mean > 0 ? "+" : ""}${emptyKmDiff.mean.toFixed(0)} km` : "—"}
        sub={emptyKmDiff ? `ORYXX emptier in ${(emptyKmDiff.rightWins / Math.max(1, emptyKmDiff.n) * 100).toFixed(0)}% of seeds` : ""}
        tone={emptyKmDiff && emptyKmDiff.mean < 0 ? "emerald" : "rose"}
      />
      <HeadlineCard
        icon={Activity}
        label="Matching rate vs ordinary"
        value={matchRateDiff ? `${matchRateDiff.mean > 0 ? "+" : ""}${(matchRateDiff.mean * 100).toFixed(1)}pp` : "—"}
        sub={matchRateDiff ? `win rate ${(matchRateDiff.winRate * 100).toFixed(0)}%` : ""}
        tone={matchRateDiff && matchRateDiff.mean >= 0 ? "emerald" : "amber"}
      />
      <HeadlineCard
        icon={Gauge}
        label="Heuristic gap (clairvoyant − ORYXX)"
        value={clairvoyantGap ? `${clairvoyantGap.mean.toFixed(1)}` : "n/a"}
        sub={clairvoyantGap ? `gap is ${(Math.abs(clairvoyantGap.mean) / Math.max(1, result.statistics["clairvoyant.totalRiskAdjustedWelfare"]?.mean || 1) * 100).toFixed(1)}% of optimum` : "exact disabled (demands > 16)"}
        tone="violet"
      />
    </div>
  );
}

function HeadlineCard({ icon: Icon, label, value, sub, tone }: { icon: any; label: string; value: string; sub: string; tone: "emerald" | "rose" | "amber" | "violet" }) {
  const color = { emerald: "text-emerald-600", rose: "text-rose-600", amber: "text-amber-600", violet: "text-violet-600" }[tone];
  return (
    <Card className="py-0">
      <div className="p-4">
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3.5 w-3.5 ${color}`} />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        </div>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
        <p className="text-[11px] text-muted-foreground">{sub}</p>
      </div>
    </Card>
  );
}

function DistributionChart({ result, activeMetric, setActiveMetric }: { result: ExperimentResult; activeMetric: string; setActiveMetric: (m: string) => void }) {
  const strategyIds = result.config.strategies.filter((s) => s !== "clairvoyant" || result.config.numDemands <= 16);
  // build per-strategy mean+CI data
  const data = strategyIds.map((sid) => {
    const s = result.statistics[`${sid}.${activeMetric}`];
    return {
      strategy: STRATEGIES.find((x) => x.id === sid)?.shortName ?? sid,
      mean: s?.mean ?? 0,
      errorY: [(s?.mean ?? 0) - (s?.ci95Low ?? 0), (s?.ci95High ?? 0) - (s?.mean ?? 0)],
      errorRange: [s?.ci95Low ?? 0, s?.ci95High ?? 0],
      color: STRAT_COLOR[sid],
    };
  });

  return (
    <Card className="py-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Distribution: {METRIC_LABELS[activeMetric] ?? activeMetric}</span>
        <Select value={activeMetric} onValueChange={setActiveMetric}>
          <SelectTrigger className="h-7 w-56 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.keys(METRIC_LABELS).map((m) => (
              <SelectItem key={m} value={m}>{METRIC_LABELS[m]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
            <XAxis dataKey="strategy" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Bar dataKey="mean" name="Mean" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Bar key={i} fill={d.color} />)}
            </Bar>
            <ErrorBar dataKey="errorY" width={6} strokeWidth={1.5} stroke="hsl(var(--foreground))" />
          </BarChart>
        </ResponsiveContainer>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
          {strategyIds.map((sid) => {
            const s = result.statistics[`${sid}.${activeMetric}`];
            return (
              <span key={sid} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: STRAT_COLOR[sid] }} />
                {STRATEGIES.find((x) => x.id === sid)?.shortName}: μ={s?.mean.toFixed(2)}, CI₉₅=[{s?.ci95Low.toFixed(2)}, {s?.ci95High.toFixed(2)}], n={s?.n}
              </span>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function PairedDiffTable({ result }: { result: ExperimentResult }) {
  const comparisons = ["oryxx - ordinary", "oryxx - centralized", "clairvoyant - oryxx"];
  const metrics = ["totalRiskAdjustedWelfare", "emptyVehicleKm", "matchingRate", "totalUserCost"];
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Paired differences (per-seed, same world)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2">Comparison</th>
              {metrics.map((m) => <th key={m} className="px-4 py-2 text-right">{METRIC_LABELS[m] ?? m}</th>)}
            </tr>
          </thead>
          <tbody>
            {comparisons.map((cmp) => (
              <tr key={cmp} className="border-b last:border-0 text-[13px]">
                <td className="px-4 py-2 font-medium">{cmp}</td>
                {metrics.map((m) => {
                  const pd = result.pairedDiffs.find((p) => p.comparison === cmp && p.metric === m);
                  if (!pd) return <td key={m} className="px-4 py-2 text-right text-muted-foreground">—</td>;
                  const val = m === "matchingRate" ? pd.mean * 100 : pd.mean;
                  const unit = m === "matchingRate" ? "pp" : m === "emptyVehicleKm" ? "km" : "";
                  return (
                    <td key={m} className="px-4 py-2 text-right tabular-nums">
                      <span className={pd.mean >= 0 ? "text-emerald-600" : "text-rose-600"}>
                        {pd.mean >= 0 ? "+" : ""}{val.toFixed(m === "matchingRate" ? 1 : 1)}{unit}
                      </span>
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        ({(pd.winRate * 100).toFixed(0)}%)
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t bg-muted/20 px-4 py-2 text-[10px] text-muted-foreground">
        Each cell = mean per-seed difference (left − right). % = fraction of seeds where left beats right. Positive = left strategy better on that metric.
      </div>
    </Card>
  );
}

function StrategiesTable({ result, strategyIds }: { result: ExperimentResult; strategyIds: string[] }) {
  const metrics = ["matchingRate", "totalRiskAdjustedWelfare", "emptyVehicleKm", "totalUserCost", "seatUtilization", "avgDetourKm"];
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Strategy statistics (mean ± 95% CI)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2">Strategy</th>
              {metrics.map((m) => <th key={m} className="px-4 py-2 text-right">{METRIC_LABELS[m] ?? m}</th>)}
            </tr>
          </thead>
          <tbody>
            {strategyIds.map((sid) => (
              <tr key={sid} className="border-b last:border-0 text-[13px]">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: STRAT_COLOR[sid] }} />
                    <span className="font-medium">{STRATEGIES.find((s) => s.id === sid)?.shortName ?? sid}</span>
                    {sid === "clairvoyant" && (
                      <Badge variant="outline" className="ml-1 text-[9px]">{result.runs[0]?.metrics.clairvoyant.isExact ? "EXACT" : "HEURISTIC"}</Badge>
                    )}
                  </div>
                </td>
                {metrics.map((m) => {
                  const s = result.statistics[`${sid}.${m}`];
                  if (!s) return <td key={m} className="px-4 py-2 text-right text-muted-foreground">—</td>;
                  const val = m === "matchingRate" ? s.mean * 100 : m === "seatUtilization" ? s.mean * 100 : s.mean;
                  const unit = (m === "matchingRate" || m === "seatUtilization") ? "%" : "";
                  return (
                    <td key={m} className="px-4 py-2 text-right tabular-nums text-[12px]">
                      {val.toFixed(m === "matchingRate" || m === "seatUtilization" ? 1 : 1)}{unit}
                      <span className="block text-[9px] text-muted-foreground">[{s.ci95Low.toFixed(1)}, {s.ci95High.toFixed(1)}]</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function OpportunitiesFeed({ result }: { result: ExperimentResult }) {
  if (result.topOpportunities.length === 0) {
    return (
      <Card className="py-0">
        <div className="border-b bg-muted/30 px-4 py-2.5"><span className="text-sm font-semibold">ORYXX moments — opportunities ordinary routing missed</span></div>
        <div className="p-6 text-center text-[11px] text-muted-foreground">No latent-supply opportunities discovered in the representative seed.</div>
      </Card>
    );
  }
  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">ORYXX moments — opportunities ordinary routing missed</span>
        <Badge variant="outline" className="text-[10px]">{result.topOpportunities.length} shown</Badge>
      </div>
      <ScrollArea className="max-h-80">
        <div className="space-y-1.5 p-3">
          {result.topOpportunities.slice(0, 8).map((o) => (
            <div key={o.id} className="rounded-lg border bg-card p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium capitalize">{o.supplyKind.replace("carpool-npd", "carpool NPD")}</span>
                <span className="tabular-nums text-emerald-600">welfare ${o.riskAdjustedWelfare}</span>
              </div>
              <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{o.reasonWhyOrdinaryRoutingWouldMissIt}</p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
}

function FailureCases({ result }: { result: ExperimentResult }) {
  if (result.failureCases.length === 0) {
    return (
      <Card className="py-0 border-emerald-500/30">
        <div className="flex items-center gap-2 border-b bg-emerald-500/5 px-4 py-2.5">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-semibold">Where ORYXX loses</span>
        </div>
        <div className="p-4 text-[12px] text-muted-foreground">
          In this regime, ORYXX did not lose on risk-adjusted welfare in any of the {result.runs.length} seeds. This does NOT prove ORYXX always wins — it means this regime favours coordination. Try the "low-pooling" or "no-deadhead" regimes, or inspect the empty-vehicle-km paired diff (ORYXX can win welfare while losing on empty-km).
        </div>
      </Card>
    );
  }
  return (
    <Card className="py-0 border-amber-500/40">
      <div className="flex items-center gap-2 border-b bg-amber-500/5 px-4 py-2.5">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <span className="text-sm font-semibold">Where ORYXX loses ({result.failureCases.length} seeds)</span>
      </div>
      <ScrollArea className="max-h-64">
        <div className="space-y-1.5 p-3">
          {result.failureCases.slice(0, 10).map((f) => (
            <div key={f.seed} className="rounded-lg border bg-card p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium">seed {f.seed}</span>
                <span className="tabular-nums text-rose-600">
                  ORYXX ${f.metrics.oryxx.totalRiskAdjustedWelfare.toFixed(1)} vs ordinary ${f.metrics.ordinary.totalRiskAdjustedWelfare.toFixed(1)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Δ = ${(f.metrics.oryxx.totalRiskAdjustedWelfare - f.metrics.ordinary.totalRiskAdjustedWelfare).toFixed(1)}
              </p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
}

function MethodologyPanel({ result }: { result: ExperimentResult }) {
  return (
    <Card className="bg-muted/20 py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Methodology</span>
      </div>
      <div className="space-y-3 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        <div>
          <Badge variant="outline" className="mr-1 text-[9px]">SIMULATION FACT</Badge>
          Numbers are computed under the current model with {result.runs.length} seeds. They are NOT empirical facts about real transportation.
        </div>
        <div>
          <Badge variant="outline" className="mr-1 text-[9px]">ASSUMPTION</Badge>
          World parameters: deadhead ratio {result.config.world.deadheadRatioRideshare}, reposition {result.config.world.repositionRatioAfterDrop}, reliability weight {result.config.world.reliabilityWeight}. These are tunable assumptions, not measurements.
        </div>
        <div>
          <Badge variant="outline" className="mr-1 text-[9px]">MODEL LIMITATION</Badge>
          The simulated world is synthetic. Welfare is risk-adjusted social surplus = (value − supplierCost) × executionProbability × (reliabilityWeight + (1−reliabilityWeight)×reliability). Price is a transfer — it cannot create welfare (invariant verified per seed).
        </div>
        <div>
          <Badge variant="outline" className="mr-1 text-[9px]">SOLVER</Badge>
          ORYXX + centralized = welfare-greedy + bounded 2-opt (HEURISTIC). Clairvoyant = exact branch-and-bound (EXACT, only for ≤{result.config.exactMaxDemands} demands — otherwise falls back to heuristic). Heuristic gap reported above.
        </div>
        <div className="text-[10px]">
          Reproducible: regime={result.config.strategies.join(",")} · seeds {result.config.seed}–{result.config.seed + result.runs.length - 1} · demands={result.config.numDemands} · region={result.config.regionKm}km
        </div>
      </div>
    </Card>
  );
}
