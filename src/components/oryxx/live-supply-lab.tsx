"use client";

// ORYXX — Live Supply Lab
//
// Displays the live supply experiment results: baseline (ordinary routing)
// vs ORYXX (with live Citi Bike station availability).
//
// All values are MODELLED planning estimates, NOT marketplace transactions.
// This experiment CANNOT produce W3-M/W4-M evidence.

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, Activity, MapPin, Bike, Clock, TrendingDown, TrendingUp,
  AlertCircle, Zap,
} from "lucide-react";

interface ExperimentResult {
  experimentId: string;
  runTimestamp: string;
  snapshotTimestamp: string;
  stationCount: number;
  stationsWithBikes: number;
  totalBikesObserved: number;
  baseline: { opportunities: number; feasibleOpportunities: number; meanTravelTimeMin: number; estimatedValue: number };
  oryxx: {
    opportunities: number; feasibleOpportunities: number; additionalOpportunities: number;
    meanTravelTimeMin: number; meanWalkingKm: number; estimatedValue: number;
    estimatedValueDelta: number; travelTimeDeltaMin: number; walkingBurdenDeltaKm: number;
  };
  freshness: { windowSec: number; stationsWithinWindow: number; stationsExpired: number; expiryRate: number };
  provenance: { environment: string; source: string; snapshotType: string; noW3M: boolean; noW4M: boolean };
  classifications: { observed: string[]; inferred: string[]; assumed: string[]; unknown: string[] };
}

export function LiveSupplyLab() {
  const { toast } = useToast();
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [sweep, setSweep] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const runExperiment = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oryxx/live-supply?view=experiment");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data);
    } catch (e) {
      toast({ title: "Experiment failed", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const runSweep = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oryxx/live-supply?view=freshness_sweep");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSweep(data.sweep || []);
    } catch (e) {
      toast({ title: "Sweep failed", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { runExperiment(); }, [runExperiment]);

  return (
    <div className="space-y-4">
      {/* PROVENANCE BANNER — always visible */}
      <Card className="p-4 border-amber-300 bg-amber-50 dark:bg-amber-950/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <h3 className="font-semibold text-amber-900 dark:text-amber-200">
              Citi Bike data is observed station inventory.
            </h3>
            <p className="text-sm text-amber-800 dark:text-amber-300">
              ORYXX cannot reserve or book these bikes through this integration.
              This experiment measures planning/opportunity discovery only.
              It does not measure provider willingness, acceptance, execution, or completion.
              All values are <strong>MODELLED</strong>, not realized.
            </p>
          </div>
        </div>
      </Card>

      {/* Experiment controls */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium flex items-center gap-2"><Zap className="h-4 w-4" /> Live Supply Experiment</h3>
          <div className="flex gap-2">
            <Button onClick={runExperiment} disabled={loading} size="sm">
              {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Activity className="h-4 w-4 mr-1" />}
              Run Experiment
            </Button>
            <Button onClick={runSweep} disabled={loading} variant="outline" size="sm">
              Freshness Sweep
            </Button>
          </div>
        </div>
      </Card>

      {/* Results */}
      {result && (
        <>
          {/* Snapshot info */}
          <Card className="p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Bike className="h-4 w-4" /> Citi Bike NYC — Live Observation Snapshot</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat icon={MapPin} label="Stations" value={result.stationCount} />
              <Stat icon={Bike} label="Stations with bikes" value={result.stationsWithBikes} />
              <Stat icon={Bike} label="Total bikes observed" value={result.totalBikesObserved} />
              <Stat icon={Clock} label="Freshness window" value={`${result.freshness.windowSec}s`} />
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Snapshot: {result.snapshotTimestamp} | Source: {result.provenance.source} | Type: {result.provenance.snapshotType}
            </div>
          </Card>

          {/* Baseline vs ORYXX comparison */}
          <Card className="p-4">
            <h3 className="text-sm font-medium mb-3">Baseline vs ORYXX (MODELLED)</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="p-3 rounded border">
                <div className="text-xs text-muted-foreground">Baseline opportunities</div>
                <div className="text-lg font-semibold">{result.baseline.opportunities}</div>
              </div>
              <div className="p-3 rounded border">
                <div className="text-xs text-muted-foreground">ORYXX opportunities</div>
                <div className="text-lg font-semibold">{result.oryxx.opportunities}</div>
              </div>
              <div className="p-3 rounded border">
                <div className="text-xs text-muted-foreground">Additional (ORYXX only)</div>
                <div className="text-lg font-semibold text-green-600">{result.oryxx.additionalOpportunities}</div>
              </div>
              <div className="p-3 rounded border">
                <div className="text-xs text-muted-foreground">Baseline mean time (min)</div>
                <div className="text-lg font-semibold">{result.baseline.meanTravelTimeMin}</div>
              </div>
              <div className="p-3 rounded border">
                <div className="text-xs text-muted-foreground">ORYXX mean time (min)</div>
                <div className="text-lg font-semibold">{result.oryxx.meanTravelTimeMin}</div>
              </div>
              <div className="p-3 rounded border">
                <div className="text-xs text-muted-foreground">Time delta (min)</div>
                <div className={`text-lg font-semibold ${result.oryxx.travelTimeDeltaMin < 0 ? "text-green-600" : "text-red-600"}`}>
                  {result.oryxx.travelTimeDeltaMin > 0 ? "+" : ""}{result.oryxx.travelTimeDeltaMin}
                </div>
              </div>
            </div>
          </Card>

          {/* Freshness */}
          <Card className="p-4">
            <h3 className="text-sm font-medium mb-3">Freshness Analysis</h3>
            <div className="grid grid-cols-3 gap-3">
              <Stat icon={Clock} label="Within window" value={result.freshness.stationsWithinWindow} />
              <Stat icon={AlertCircle} label="Expired" value={result.freshness.stationsExpired} />
              <Stat icon={TrendingDown} label="Expiry rate" value={`${(result.freshness.expiryRate * 100).toFixed(1)}%`} />
            </div>
          </Card>

          {/* Classification */}
          <Card className="p-4">
            <h3 className="text-sm font-medium mb-3">Evidence Classification</h3>
            <div className="space-y-2 text-xs">
              <div><strong>OBSERVED:</strong> {result.classifications.observed.join(", ")}</div>
              <div><strong>INFERRED:</strong> {result.classifications.inferred.join(", ")}</div>
              <div><strong>ASSUMED:</strong> {result.classifications.assumed.join(", ")}</div>
              <div><strong>UNKNOWN:</strong> {result.classifications.unknown.join(", ")}</div>
            </div>
          </Card>

          {/* Evidence boundary */}
          <Card className="p-3 border-green-300 bg-green-50 dark:bg-green-950/20">
            <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
              <Badge variant="outline">OBSERVED_ONLY</Badge>
              <span>W3-M = 0</span>
              <span>·</span>
              <span>W4-M = 0</span>
              <span>·</span>
              <span>No marketplace transactions</span>
            </div>
          </Card>
        </>
      )}

      {/* Freshness sweep results */}
      {sweep.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3">Freshness Sweep</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Window</th>
                  <th className="p-2 text-right">Stations</th>
                  <th className="p-2 text-right">Expiry %</th>
                  <th className="p-2 text-right">Time Δ (min)</th>
                  <th className="p-2 text-right">Value Δ</th>
                </tr>
              </thead>
              <tbody>
                {sweep.map((s, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-2">{s.windowSec}s</td>
                    <td className="p-2 text-right">{s.stationsWithinWindow}</td>
                    <td className="p-2 text-right">{(s.expiryRate * 100).toFixed(1)}%</td>
                    <td className="p-2 text-right">{s.travelTimeDeltaMin}</td>
                    <td className="p-2 text-right">{s.estimatedValueDelta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: any }) {
  return (
    <div className="p-3 rounded border">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}
