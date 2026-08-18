"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Package,
  MapPin,
  Clock,
  DollarSign,
  ShieldCheck,
  Scale,
  Cpu,
  CircleDot,
} from "lucide-react";
import type { TransportationEvent, SolveResponse } from "@/lib/oryxx/types";
import { AUTONOMY_LEVELS } from "@/lib/oryxx/world";

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: any;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <Icon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <div className="text-xs">{children}</div>
      </div>
    </div>
  );
}

export function ParsedEventCard({ response }: { response: SolveResponse }) {
  const e: TransportationEvent = response.event;
  const auto = AUTONOMY_LEVELS.find((a) => a.level === e.autonomy);
  const parsedByLabel =
    response.parsedBy === "llm"
      ? "Parsed by ORYXX LLM"
      : response.parsedBy === "heuristic"
      ? "Heuristic parse (LLM unavailable)"
      : "Structured input";

  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-semibold">Parsed Transportation Event</span>
        </div>
        <Badge
          variant="outline"
          className={
            response.parsedBy === "llm"
              ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
              : "border-amber-500/40 text-amber-700 dark:text-amber-300"
          }
        >
          {parsedByLabel}
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-x-6 px-4 py-3 sm:grid-cols-2">
        <div>
          <Row icon={Package} label="Object">
            <span className="font-medium capitalize">{e.object.kind}</span> · {e.object.label}
            {e.object.count > 1 && <span> ×{e.object.count}</span>}
            {e.object.temperatureControlled && (
              <Badge variant="outline" className="ml-1 text-[10px] text-rose-600">
                temp-controlled
              </Badge>
            )}
          </Row>
          <Row icon={MapPin} label="Origin → Destination">
            <span className="font-medium">{e.origin}</span>
            <span className="mx-1 text-muted-foreground">→</span>
            <span className="font-medium">{e.destination}</span>
          </Row>
          <Row icon={Clock} label="Time window">
            <span>earliest {e.earliestDeparture}</span>
            {e.preferredDeparture && <span> · preferred {e.preferredDeparture}</span>}
            {e.latestArrival && <span> · latest arr. {e.latestArrival}</span>}
          </Row>
        </div>
        <div>
          <Row icon={DollarSign} label="Constraints">
            {e.constraints.budget != null ? (
              <span>budget ≤ ${e.constraints.budget}</span>
            ) : (
              <span className="text-muted-foreground">no budget cap</span>
            )}
            {e.constraints.maxTransfers != null && (
              <span> · ≤{e.constraints.maxTransfers} transfers</span>
            )}
            {e.constraints.maxWalkingKm != null && (
              <span> · ≤{e.constraints.maxWalkingKm} km walk</span>
            )}
            {e.constraints.vehicleRequirements?.length ? (
              <span> · {e.constraints.vehicleRequirements.join(", ")}</span>
            ) : null}
          </Row>
          <Row icon={Scale} label="Risk tolerance">
            <span className="capitalize">{e.riskTolerance.replace("-", " ")}</span>
          </Row>
          <Row icon={ShieldCheck} label="Objectives (weighted)">
            <div className="flex flex-wrap gap-1">
              {Object.entries(e.objectives)
                .filter(([, v]) => Number(v) >= 0.6)
                .sort((a, b) => Number(b[1]) - Number(a[1]))
                .map(([k, v]) => (
                  <Badge key={k} variant="secondary" className="text-[10px] capitalize">
                    {k} {Math.round(Number(v) * 100)}%
                  </Badge>
                ))}
            </div>
          </Row>
          <Row icon={CircleDot} label="Autonomy authority">
            <span className="font-medium">L{e.autonomy} — {auto?.name}</span>
            <p className="text-[11px] text-muted-foreground">{auto?.desc}</p>
          </Row>
        </div>
      </div>
      {response.unknowns.length > 0 && (
        <div className="border-t bg-amber-500/5 px-4 py-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Honest unknowns (ORYXX does not pretend certainty)
          </p>
          <ul className="mt-1 space-y-0.5">
            {response.unknowns.map((u, i) => (
              <li key={i} className="text-[11px] text-muted-foreground">
                · {u}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
