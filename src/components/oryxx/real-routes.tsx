"use client";

import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Globe,
  Loader2,
  MapPin,
  AlertTriangle,
  Route as RouteIcon,
  CheckCircle2,
  XCircle,
  Info,
} from "lucide-react";
import type { Plan, TransportationEvent } from "@/lib/oryxx/types";
import { IntentConsole, type SolvePayload } from "@/components/oryxx/intent-console";
import { PlanCard } from "@/components/oryxx/plan-card";

interface GeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
  provenance: { environment: string; source: string; observedAt: string; confidence: number };
}

interface RealSolveResponse {
  event: TransportationEvent;
  parsedBy: "llm" | "heuristic" | "structured";
  plans: Plan[];
  unknowns: string[];
  generatedAt: string;
  geocoded: { origin: GeocodeResult | null; destination: GeocodeResult | null };
  environment: "REAL_DATA_OBSERVED_ONLY";
}

export function RealRoutes() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<RealSolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const callSolve = useCallback(
    async (payload: SolvePayload) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/oryxx/solve-real", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `Real solver returned ${res.status}`);
        }
        const data: RealSolveResponse = await res.json();
        setResponse(data);
        toast({
          title: `${data.plans.length} real-route plan${data.plans.length === 1 ? "" : "s"}`,
          description:
            data.plans.length > 0
              ? "Distances + travel times from OSRM road network. Cost/emissions modelled."
              : "Geocoding may have failed — see notes below.",
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? "Unknown error";
        setError(msg);
        toast({ title: "Real solver error", description: msg, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* Input */}
      <div className="space-y-4">
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Globe className="h-4 w-4 text-emerald-600" />
            <h2 className="text-sm font-semibold">Real-Network Intent</h2>
            <Badge variant="secondary" className="ml-auto text-[10px]">REAL data</Badge>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Same intent parser as the synthetic solver, but routes resolve against the{" "}
            <strong>real road network</strong> (OSRM), real geocoding (OSM Nominatim), and
            augment with real observed supply (Citi Bike near NYC, GTFS schedules near Boston).
            Cost &amp; emissions remain <strong>modelled</strong> until a real pricing API is wired.
          </p>
          <IntentConsole onSolve={callSolve} loading={loading} />
        </Card>

        {response && (
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Geocoded (REAL)</h3>
            </div>
            <GeocodeRow label="Origin" result={response.geocoded.origin} />
            <GeocodeRow label="Destination" result={response.geocoded.destination} />
            <Separator className="my-3" />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Environment</span>
              <Badge variant="outline" className="text-[10px]">{response.environment}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Parsed by</span>
              <span className="font-mono">{response.parsedBy}</span>
            </div>
          </Card>
        )}
      </div>

      {/* Results */}
      <div className="space-y-4">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
            <span className="ml-2 text-sm text-muted-foreground">
              Geocoding + routing against real road network…
            </span>
          </div>
        )}

        {error && (
          <Card className="border-destructive/40 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          </Card>
        )}

        {!loading && !response && !error && (
          <Card className="flex flex-col items-center justify-center py-16 text-center">
            <RouteIcon className="mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Enter a real-world origin &amp; destination to solve against the live road network.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              e.g. “Times Square to Central Park by 8pm, cheapest”
            </p>
          </Card>
        )}

        {!loading && response && response.plans.length === 0 && (
          <Card className="p-6">
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              <span>No real routes returned.</span>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              This usually means geocoding could not resolve one or both place names via OSM
              Nominatim, or OSRM returned no route. See the notes below.
            </p>
          </Card>
        )}

        {!loading && response && response.plans.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <RouteIcon className="h-4 w-4 text-emerald-600" />
              <h2 className="text-sm font-semibold">
                {response.plans.length} real-route plan{response.plans.length === 1 ? "" : "s"}
              </h2>
              <Badge variant="secondary" className="ml-auto text-[10px]">
                <CheckCircle2 className="mr-1 h-3 w-3 text-emerald-600" /> REAL distances
              </Badge>
            </div>
            {response.plans.map((plan, i) => (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <PlanCard plan={plan} />
                <div className="mt-1 flex flex-wrap gap-1 px-1">
                  <Badge variant="outline" className="text-[9px] text-emerald-700 dark:text-emerald-400">
                    REAL distance/time (OSRM)
                  </Badge>
                  <Badge variant="outline" className="text-[9px] text-amber-700 dark:text-amber-400">
                    MODELLED cost/emissions
                  </Badge>
                  <Badge variant="outline" className="text-[9px]">OBSERVED_ONLY</Badge>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {!loading && response && response.unknowns.length > 0 && (
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Honesty notes</h3>
            </div>
            <ul className="space-y-1.5">
              {response.unknowns.map((u, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                  <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground/50" />
                  <span>{u}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function GeocodeRow({ label, result }: { label: string; result: GeocodeResult | null }) {
  if (!result) {
    return (
      <div className="flex items-center justify-between py-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1 text-destructive">
          <XCircle className="h-3 w-3" /> not resolved
        </span>
      </div>
    );
  }
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <Badge variant="outline" className="text-[9px]">
          <CheckCircle2 className="mr-1 h-2.5 w-2.5 text-emerald-600" />
          {result.provenance.source}
        </Badge>
      </div>
      <div className="mt-0.5 text-xs font-medium leading-snug">{result.displayName}</div>
      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
        {result.lat.toFixed(4)}, {result.lon.toFixed(4)}
        <span className="ml-2">conf {(result.provenance.confidence ?? 0).toFixed(2)}</span>
      </div>
    </div>
  );
}
