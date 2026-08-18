"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
} from "recharts";
import {
  Play,
  Loader2,
  FlaskConical,
  TrendingDown,
  Users,
  Route,
  Leaf,
  Gauge,
  Sparkles,
  Truck,
  TrainFront,
  Car,
  Footprints,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import type { SimulationConfig, SimulationResult } from "@/lib/oryxx/market/types";

interface ConfigState {
  numDemands: number;
  numDrivers: number;
  numNPDs: number;
  numTrucks: number;
  numTransitLines: number;
  regionKm: number;
  seed: number;
}

const DEFAULTS: ConfigState = {
  numDemands: 400,
  numDrivers: 80,
  numNPDs: 50,
  numTrucks: 25,
  numTransitLines: 6,
  regionKm: 22,
  seed: 42,
};

export function MarketSimulator() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<ConfigState>(DEFAULTS);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oryxx/market/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data: SimulationResult = await res.json();
      setResult(data);
      toast({
        title: "Simulation complete",
        description: `${data.demands.length} demands · ${data.supplies.length} supplies · waste removed ${data.wasteRemoved.pctEmptyKm}% empty-km`,
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? "Unknown error";
      setError(msg);
      toast({ title: "Simulation failed", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setResult(null);
    setError(null);
    setCfg(DEFAULTS);
  };

  const setNum = (k: keyof ConfigState) => (v: number) => setCfg((c) => ({ ...c, [k]: v }));

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
              <p className="text-sm font-semibold leading-tight">Transportation Market Simulator</p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Inject demand + supply populations · compare ORYXX market clearing vs ordinary routing
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={reset} disabled={loading}>
              <RefreshCw className="mr-1 h-3 w-3" /> Reset
            </Button>
            <Button
              size="sm"
              onClick={run}
              disabled={loading}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {loading ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…</>
              ) : (
                <><Play className="mr-2 h-4 w-4" /> Run simulation</>
              )}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <SliderField
            label="Transportation demands"
            value={cfg.numDemands}
            min={50}
            max={1500}
            step={50}
            onChange={setNum("numDemands")}
            hint="trips to move (people + freight)"
          />
          <SliderField
            label="Committed drivers"
            value={cfg.numDrivers}
            min={0}
            max={300}
            step={10}
            onChange={setNum("numDrivers")}
            hint="active rideshare fleet, driving anyway"
          />
          <SliderField
            label="Latent supply (NPDs)"
            value={cfg.numNPDs}
            min={0}
            max={150}
            step={5}
            onChange={setNum("numNPDs")}
            hint="pre-existing trips with spare seats"
          />
          <SliderField
            label="Trucks (freight)"
            value={cfg.numTrucks}
            min={0}
            max={150}
            step={5}
            onChange={setNum("numTrucks")}
            hint="often with empty return legs"
          />
          <SliderField
            label="Transit lines"
            value={cfg.numTransitLines}
            min={0}
            max={12}
            step={1}
            onChange={setNum("numTransitLines")}
            hint="scheduled, high-capacity, recurring"
          />
          <SliderField
            label="Region size (km)"
            value={cfg.regionKm}
            min={8}
            max={60}
            step={2}
            onChange={setNum("regionKm")}
            hint="simulated geography extent"
          />
          <div className="space-y-1.5 sm:col-span-1">
            <Label className="text-xs text-muted-foreground">Random seed</Label>
            <Input
              type="number"
              value={cfg.seed}
              onChange={(e) => setNum("seed")(Number(e.target.value) || 42)}
              className="h-8"
            />
            <p className="text-[10px] text-muted-foreground">deterministic — same seed = same market</p>
          </div>
        </div>
      </Card>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="space-y-6"
        >
          {/* Headline: waste removed */}
          <WasteRemovedHeadline result={result} />

          {/* Population summary */}
          <PopulationSummary result={result} />

          {/* Comparison charts */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ComparisonChart result={result} />
            <ModeBreakdown result={result} />
          </div>

          {/* Metrics table */}
          <MetricsTable result={result} />

          {/* ORYXX moments */}
          <OpportunitiesFeed result={result} />

          {/* Honesty note */}
          <Card className="bg-muted/20 py-0">
            <div className="px-4 py-3">
              <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>
                  <strong className="text-foreground">Honesty note.</strong> {result.solverNote} The
                  simulated world is synthetic — these numbers prove the <em>mechanism</em> (ORYXX
                  discovers latent-supply + transit + truck-backhaul opportunities that ordinary
                  routing structurally cannot), not yet real-world performance.
                </span>
              </p>
            </div>
          </Card>
        </motion.div>
      )}
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
      />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function WasteRemovedHeadline({ result }: { result: SimulationResult }) {
  const w = result.wasteRemoved;
  const isPositive = w.pctEmptyKm >= 0;
  return (
    <Card className="overflow-hidden py-0">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <HeadlineStat
          icon={TrendingDown}
          label="Empty vehicle-km removed"
          value={`${w.pctEmptyKm}%`}
          sub={`${w.emptyVehicleKm} km saved`}
          tone="emerald"
        />
        <HeadlineStat
          icon={Users}
          label="User cost saved (apples-to-apples)"
          value={`${w.pctUserCost}%`}
          sub={`$${w.userCostSavings} saved`}
          tone="emerald"
        />
        <HeadlineStat
          icon={Gauge}
          label="Welfare gain"
          value={`${w.pctWelfare}%`}
          sub={`+$${w.welfareGain}`}
          tone="emerald"
        />
        <HeadlineStat
          icon={Route}
          label="Additional demands served"
          value={`${w.additionalMatches >= 0 ? "+" : ""}${w.additionalMatches}`}
          sub={`${w.pctMatchingRate >= 0 ? "+" : ""}${w.pctMatchingRate}pts matching rate`}
          tone={w.additionalMatches >= 0 ? "emerald" : "amber"}
        />
      </div>
    </Card>
  );
}

function HeadlineStat({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: any;
  label: string;
  value: string;
  sub: string;
  tone: "emerald" | "amber";
}) {
  const color = tone === "emerald" ? "text-emerald-600" : "text-amber-600";
  return (
    <div className="border-b border-r p-4 last:border-r-0 sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(4n)]:border-r-0">
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${color}`} />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <p className={`mt-1 text-3xl font-bold tabular-nums ${color}`}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function PopulationSummary({ result }: { result: SimulationResult }) {
  const byKind: Record<string, number> = {};
  result.supplies.forEach((s) => (byKind[s.kind] = (byKind[s.kind] ?? 0) + 1));
  const demandsByKind: Record<string, number> = {};
  result.demands.forEach((d) => (demandsByKind[d.kind] = (demandsByKind[d.kind] ?? 0) + 1));
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Generated population</span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        <Stat icon={Users} label="Demands" value={result.demands.length} sub={Object.entries(demandsByKind).map(([k, v]) => `${k}:${v}`).join(" · ")} />
        <Stat icon={Car} label="Drivers" value={byKind["rideshare"] ?? 0} sub="committed fleet" />
        <Stat icon={Sparkles} label="NPDs" value={byKind["carpool-npd"] ?? 0} sub="latent supply" />
        <Stat icon={Truck} label="Trucks" value={byKind["truck"] ?? 0} sub="freight capacity" />
      </div>
    </Card>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: any; label: string; value: number; sub: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px]">{label}</span>
      </div>
      <p className="mt-0.5 text-xl font-bold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function ComparisonChart({ result }: { result: SimulationResult }) {
  const data = [
    { metric: "Matching rate %", ordinary: +(result.baseline.metrics.matchingRate * 100).toFixed(1), oryxx: +(result.oryxx.metrics.matchingRate * 100).toFixed(1) },
    { metric: "Empty km", ordinary: result.baseline.metrics.emptyVehicleKm, oryxx: result.oryxx.metrics.emptyVehicleKm },
    { metric: "User cost $", ordinary: result.baseline.metrics.totalUserCost, oryxx: result.oryxx.metrics.totalUserCost },
    { metric: "Welfare $", ordinary: result.baseline.metrics.totalWelfare, oryxx: result.oryxx.metrics.totalWelfare },
    { metric: "Seat util %", ordinary: +(result.baseline.metrics.seatUtilization * 100).toFixed(1), oryxx: +(result.oryxx.metrics.seatUtilization * 100).toFixed(1) },
  ];
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">ORYXX vs ordinary routing</span>
      </div>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
            <XAxis dataKey="metric" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="ordinary" name="Ordinary" fill="#f59e0b" radius={[3, 3, 0, 0]} />
            <Bar dataKey="oryxx" name="ORYXX" fill="#10b981" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function ModeBreakdown({ result }: { result: SimulationResult }) {
  const byKind: Record<string, { count: number; saved: number }> = {};
  result.oryxx.matches.forEach((m) => {
    const k = m.supplyKind;
    if (!byKind[k]) byKind[k] = { count: 0, saved: 0 };
    byKind[k].count++;
    byKind[k].saved += m.savingVsOrdinary;
  });
  const data = Object.entries(byKind).map(([k, v]) => ({
    mode: k.replace("carpool-npd", "carpool"),
    matches: v.count,
    saved: Math.round(v.saved * 100) / 100,
  }));
  const total = data.reduce((a, d) => a + d.matches, 0);
  const radialData = data.map((d) => ({ name: d.mode, value: total > 0 ? Math.round((d.matches / total) * 100) : 0, fill: MODE_FILL[d.name] ?? "#94a3b8" }));
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">ORYXX match composition</span>
      </div>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={260}>
          <RadialBarChart innerRadius="30%" outerRadius="100%" data={radialData} startAngle={90} endAngle={-270}>
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar background dataKey="value" cornerRadius={6} />
            <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="mt-2 space-y-1">
          {data.map((d) => (
            <div key={d.mode} className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 capitalize">
                <span className="h-2 w-2 rounded-full" style={{ background: MODE_FILL[d.mode] ?? "#94a3b8" }} />
                {d.mode}
              </span>
              <span className="tabular-nums">
                {d.matches} matches · <span className="text-emerald-600">${d.saved} saved</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

const MODE_FILL: Record<string, string> = {
  rideshare: "#f43f5e",
  carpool: "#8b5cf6",
  truck: "#f59e0b",
  transit: "#10b981",
};

function MetricsTable({ result }: { result: SimulationResult }) {
  const b = result.baseline.metrics;
  const o = result.oryxx.metrics;
  const rows = [
    ["Demands matched", `${b.matchedDemands}`, `${o.matchedDemands}`],
    ["Matching rate", `${(b.matchingRate * 100).toFixed(1)}%`, `${(o.matchingRate * 100).toFixed(1)}%`],
    ["Total user cost", `$${b.totalUserCost}`, `$${o.totalUserCost}`],
    ["Total driver earnings", `$${b.totalDriverEarnings}`, `$${o.totalDriverEarnings}`],
    ["Total driver cost", `$${b.totalDriverCost}`, `$${o.totalDriverCost}`],
    ["Total welfare", `$${b.totalWelfare}`, `$${o.totalWelfare}`],
    ["Seat utilization", `${(b.seatUtilization * 100).toFixed(1)}%`, `${(o.seatUtilization * 100).toFixed(1)}%`],
    ["Empty vehicle-km", `${b.emptyVehicleKm}`, `${o.emptyVehicleKm}`],
    ["Avg travel time", `${b.avgTravelTimeMin}m`, `${o.avgTravelTimeMin}m`],
    ["Avg detour", `${b.avgDetourKm}km`, `${o.avgDetourKm}km`],
    ["Unserved demand value", `$${b.unservedDemandValue}`, `$${o.unservedDemandValue}`],
  ];
  return (
    <Card className="py-0">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">Full metrics comparison</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2">Metric</th>
              <th className="px-4 py-2 text-right">Ordinary routing</th>
              <th className="px-4 py-2 text-right">ORYXX</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b last:border-0 text-[13px]">
                <td className="px-4 py-2 text-muted-foreground">{r[0]}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r[1]}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{r[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function OpportunitiesFeed({ result }: { result: SimulationResult }) {
  if (result.topOpportunities.length === 0) {
    return (
      <Card className="py-0">
        <div className="border-b bg-muted/30 px-4 py-2.5">
          <span className="text-sm font-semibold">ORYXX moments — opportunities ordinary routing missed</span>
        </div>
        <div className="p-6 text-center text-[11px] text-muted-foreground">
          No latent-supply opportunities found for this population.
        </div>
      </Card>
    );
  }
  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <span className="text-sm font-semibold">ORYXX moments — opportunities ordinary routing missed</span>
        <Badge variant="outline" className="text-[10px]">{result.topOpportunities.length} shown</Badge>
      </div>
      <ScrollArea className="max-h-96">
        <div className="space-y-1.5 p-3">
          {result.topOpportunities.map((m) => {
            const d = result.demands.find((x) => x.id === m.demandId)!;
            const Icon = m.supplyKind === "transit" ? TrainFront : m.supplyKind === "truck" ? Truck : m.supplyKind === "carpool-npd" ? Users : Car;
            return (
              <div key={m.demandId} className="flex items-center gap-3 rounded-lg border bg-card p-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {d.originName} → {d.destName}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    <span className="capitalize">{d.kind}</span> · {m.supplyKind.replace("carpool-npd", "carpool NPD")} · depart {fmtMin(m.departAt)}
                  </p>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground line-through">${m.ordinaryCost.toFixed(2)}</span>
                    <span className="text-sm font-bold text-emerald-600">${m.price.toFixed(2)}</span>
                  </div>
                  <p className="text-[11px] font-medium text-emerald-600">save ${m.savingVsOrdinary}</p>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </Card>
  );
}

function fmtMin(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
}
