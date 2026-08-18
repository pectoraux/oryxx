"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sparkles,
  Wand2,
  Settings2,
  Loader2,
  ChevronDown,
  Sliders,
} from "lucide-react";
import type {
  AutonomyLevel,
  ObjectiveWeights,
  RiskTolerance,
  TransportationEvent,
  ObjectKind,
} from "@/lib/oryxx/types";
import { AUTONOMY_LEVELS } from "@/lib/oryxx/world";

const EXAMPLES = [
  "I need to get from Northern Suburbs to Downtown Core by 8 PM",
  "Move 10 boxes from Market Square to Warehouse District by Thursday, cheapest",
  "Get me from Downtown Core to International Airport by 9am, safest",
  "2 people from University District to Harbor Terminal, under $20",
  "Get my children from Old Town to Market Square every weekday — find the most reliable option",
];

export type SolvePayload =
  | { intent: string }
  | { event: Partial<TransportationEvent> };

const DEFAULT_OBJECTIVES: ObjectiveWeights = {
  cost: 0.7,
  time: 0.7,
  reliability: 0.6,
  emissions: 0.35,
  comfort: 0.4,
  transfers: 0.5,
  walking: 0.4,
  safety: 0.55,
};

export function IntentConsole({
  onSolve,
  loading,
}: {
  onSolve: (payload: SolvePayload) => void;
  loading: boolean;
}) {
  const [intent, setIntent] = useState(EXAMPLES[0]);
  const [manual, setManual] = useState(false);

  // structured draft
  const [kind, setKind] = useState<ObjectKind>("person");
  const [count, setCount] = useState(1);
  const [origin, setOrigin] = useState("Northern Suburbs");
  const [destination, setDestination] = useState("Downtown Core");
  const [earliest, setEarliest] = useState("08:00");
  const [preferred, setPreferred] = useState("");
  const [latest, setLatest] = useState("20:00");
  const [budget, setBudget] = useState("");
  const [maxTransfers, setMaxTransfers] = useState("");
  const [risk, setRisk] = useState<RiskTolerance>("balanced");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(1);
  const [objectives, setObjectives] = useState<ObjectiveWeights>(DEFAULT_OBJECTIVES);

  const solve = () => {
    if (manual) {
      onSolve({
        event: {
          object: {
            kind,
            label: kindLabel(kind, count),
            count,
          },
          origin,
          destination,
          earliestDeparture: earliest || "08:00",
          preferredDeparture: preferred || undefined,
          latestArrival: latest || undefined,
          constraints: {
            budget: budget ? Number(budget) : undefined,
            maxTransfers: maxTransfers ? Number(maxTransfers) : undefined,
          },
          objectives,
          riskTolerance: risk,
          autonomy,
          rawIntent: `${origin} to ${destination}`,
        },
      });
    } else {
      onSolve({ intent });
    }
  };

  const setObjective = (k: keyof ObjectiveWeights, v: number) =>
    setObjectives((o) => ({ ...o, [k]: v }));

  return (
    <Card className="overflow-hidden py-0">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white">
            <Wand2 className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">Transportation Intent</p>
            <p className="text-[11px] text-muted-foreground leading-tight">
              State a transportation event. ORYXX parses it, then solves deterministically.
            </p>
          </div>
        </div>
        <button
          onClick={() => setManual((m) => !m)}
          className="flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          {manual ? <Wand2 className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
          {manual ? "Use natural language" : "Build event manually"}
        </button>
      </div>

      <div className="space-y-4 p-4">
        {!manual ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="intent" className="text-xs text-muted-foreground">
                Describe the transportation event
              </Label>
              <Textarea
                id="intent"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="e.g. I need to get from A to D by 8 PM, cheapest reliable option"
                className="min-h-[88px] resize-none"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setIntent(ex)}
                  className="rounded-full border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  {ex.length > 52 ? ex.slice(0, 52) + "…" : ex}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-4">
            {/* Object */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="col-span-1 space-y-1.5 sm:col-span-2">
                <Label className="text-xs text-muted-foreground">Object</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as ObjectKind)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["person","people","parcel","cargo","pallet","container","vehicle","materials","agriculture","other"] as ObjectKind[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Count</Label>
                <Input
                  type="number"
                  min={1}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Budget ($)</Label>
                <Input
                  type="number"
                  placeholder="any"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">From</Label>
                <Input value={origin} onChange={(e) => setOrigin(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">To</Label>
                <Input value={destination} onChange={(e) => setDestination(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Earliest dep.</Label>
                <Input type="time" value={earliest} onChange={(e) => setEarliest(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Preferred dep.</Label>
                <Input type="time" value={preferred} onChange={(e) => setPreferred(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Latest arrival</Label>
                <Input type="time" value={latest} onChange={(e) => setLatest(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Max transfers</Label>
                <Input
                  type="number"
                  placeholder="any"
                  value={maxTransfers}
                  onChange={(e) => setMaxTransfers(e.target.value)}
                />
              </div>
            </div>

            {/* Objectives */}
            <ObjectiveSliders objectives={objectives} setObjective={setObjective} />

            {/* Risk + Autonomy */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Risk tolerance</Label>
                <RadioGroup
                  value={risk}
                  onValueChange={(v) => setRisk(v as RiskTolerance)}
                  className="flex gap-4"
                >
                  {(["risk-averse","balanced","risk-seeking"] as RiskTolerance[]).map((r) => (
                    <div key={r} className="flex items-center gap-1.5">
                      <RadioGroupItem value={r} id={`risk-${r}`} />
                      <Label htmlFor={`risk-${r}`} className="text-xs capitalize cursor-pointer">
                        {r.replace("-", " ")}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
            </div>

            <AutonomyPicker value={autonomy} onChange={setAutonomy} />
          </div>
        )}

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            <Sparkles className="mr-1 inline h-3 w-3" />
            LLM parses intent · deterministic solver owns feasibility
          </p>
          <Button
            onClick={solve}
            disabled={loading}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Solving…
              </>
            ) : (
              <>
                <Wand2 className="mr-2 h-4 w-4" />
                Solve transportation event
              </>
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ObjectiveSliders({
  objectives,
  setObjective,
}: {
  objectives: ObjectiveWeights;
  setObjective: (k: keyof ObjectiveWeights, v: number) => void;
}) {
  const items: { key: keyof ObjectiveWeights; label: string }[] = [
    { key: "cost", label: "Cost" },
    { key: "time", label: "Time" },
    { key: "reliability", label: "Reliability" },
    { key: "emissions", label: "Emissions" },
    { key: "comfort", label: "Comfort" },
    { key: "transfers", label: "Fewer transfers" },
    { key: "walking", label: "Less walking" },
    { key: "safety", label: "Safety" },
  ];
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sliders className="h-3.5 w-3.5" />
        Objective weights
      </div>
      <div className="grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2">
        {items.map((it) => (
          <div key={it.key} className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-muted-foreground">{it.label}</Label>
              <span className="text-[11px] font-medium tabular-nums">
                {Math.round(objectives[it.key] * 100)}%
              </span>
            </div>
            <Slider
              value={[Math.round(objectives[it.key] * 100)]}
              min={0}
              max={100}
              step={5}
              onValueChange={(v) => setObjective(it.key, v[0] / 100)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function AutonomyPicker({
  value,
  onChange,
}: {
  value: AutonomyLevel;
  onChange: (v: AutonomyLevel) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">
        Autonomy authority — how much freedom ORYXX has
      </Label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {AUTONOMY_LEVELS.map((a) => {
          const active = a.level === value;
          return (
            <button
              key={a.level}
              onClick={() => onChange(a.level as AutonomyLevel)}
              className={`rounded-lg border px-2 py-2 text-left transition ${
                active
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-border bg-background hover:bg-muted"
              }`}
            >
              <div className="flex items-center gap-1">
                <Badge
                  className={`h-5 w-5 justify-center rounded p-0 text-[10px] ${
                    active ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground"
                  }`}
                >
                  L{a.level}
                </Badge>
                <span className="text-xs font-medium">{a.name}</span>
              </div>
              <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                {a.desc}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function kindLabel(kind: ObjectKind, count: number): string {
  const map: Record<ObjectKind, string> = {
    person: "1 person",
    people: `${count} people`,
    parcel: `${count} ${count === 1 ? "parcel" : "parcels"}`,
    cargo: "cargo",
    pallet: `${count} ${count === 1 ? "pallet" : "pallets"}`,
    container: `${count} container`,
    vehicle: "vehicle",
    materials: "materials",
    agriculture: "agricultural goods",
    other: "item",
  };
  return map[kind];
}
