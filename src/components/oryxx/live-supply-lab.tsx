"use client";

// ORYXX — Live Supply Information Lab
//
// Displays the information-treatment experiment: baseline (without live
// inventory) vs ORYXX (with live inventory). Both strategies have
// identical routing modes. The ONLY difference is access to live
// Citi Bike station-availability observations.
//
// All values are MODELLED planning estimates, NOT marketplace transactions.

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, Bike, AlertCircle, Zap, TrendingUp, TrendingDown, Minus,
} from "lucide-react";

interface ExperimentResult {
  experimentId: string;
  snapshotTimestamp: string;
  stationCount: number;
  stationsWithBikes: number;
  totalBikesObserved: number;
  demandsWithStation: number;
  routeLevel: {
    newlyDiscoverableCount: number;
    newlyDiscoverableRate: number;
    oryxxWins: number;
    baselineWins: number;
    ties: number;
    neitherHasBike: number;
    meanCostDelta: number;
    meanTimeDeltaMin: number;
    improvementRate: number;
  };
  freshness: { windowSec: number; stationsWithinWindow: number; expiryRate: number };
  provenance: { environment: string; source: string; noW3M: boolean; noW4M: boolean };
  classifications: { observed: string[]; inferred: string[]; assumed: string[]; unknown: string[] };
}

export function LiveSupplyLab() {
  const { toast } = useToast();
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [sweep, setSweep] = useState<any[]>([]);
  const [invariant, setInvariant] = useState<any>(null);
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

  const runInvariant = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oryxx/live-supply?view=invariant");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInvariant(data);
    } catch (e) {
      toast({ title: "Invariant check failed", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { runExperiment(); }, [runExperiment]);

  return (
    <div className="space-y-4">
      <Card className="p-4 border-amber-300 bg-amber-50 dark:bg-amber-950/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <h3 className="font-semibold text-amber-900 dark:text-amber-200">
              Citi Bike data is observed station inventory, not bookable marketplace supply.
            </h3>
            <p className="text-sm text-amber-800 dark:text-amber-300">
              This is an information-treatment experiment. Both strategies have the same
              routing modes (walk + bike-share). The ONLY difference is access to live
              station-availability observations. All values are <strong>MODELLED</strong>.
              This does NOT measure provider willingness, acceptance, execution, or completion.
            </p>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium flex items-center gap-2"><Zap className="h-4 w-4" /> Information-Value Experiment</h3>
          <div className="flex gap-2">
            <Button onClick={runExperiment} disabled={loading} size="sm">
              {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
              Run Experiment
            </Button>
            <Button onClick={runSweep} disabled={loading} variant="outline" size="sm">
              Freshness Sweep
            </Button>
            <Button onClick={runInvariant} disabled={loading} variant="outline" size="sm">
              Invariant Check
            </Button>
          </div>
        </div>
      </Card>

      {result && (
        <>
          <Card className="p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Bike className="h-4 w-4" /> Citi Bike NYC — Live Observation Snapshot</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Stations" value={result.stationCount} />
              <Stat label="Stations with bikes" value={result.stationsWithBikes} />
              <Stat label="Total bikes" value={result.totalBikesObserved} />
              <Stat label="Demands with station nearby" value={result.demandsWithStation} />
            </div>
          </Card>

          <Card className="p-4">
            <h3 className="text-sm font-medium mb-3">Route-Level Results (MODELLED)</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Newly discoverable" value={result.routeLevel.newlyDiscoverableCount} icon={TrendingUp} color="text-green-600" />
              <Stat label="ORYXX wins" value={result.routeLevel.oryxxWins} icon={TrendingUp} color="text-green-600" />
              <Stat label="Baseline wins" value={result.routeLevel.baselineWins} icon={TrendingDown} color="text-red-600" />
              <Stat label="Ties" value={result.routeLevel.ties} icon={Minus} color="text-muted-foreground" />
              <Stat label="Mean cost Δ" value={result.routeLevel.meanCostDelta} suffix=" ¢" />
              <Stat label="Mean time Δ" value={result.routeLevel.meanTimeDeltaMin} suffix=" min" />
              <Stat label="Improvement rate" value={`${(result.routeLevel.improvementRate * 100).toFixed(1)}%`} />
              <Stat label="Neither has bike" value={result.routeLevel.neitherHasBike} />
            </div>
          </Card>

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

      {sweep.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3">Freshness Sweep</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Window</th>
                  <th className="p-2 text-right">New</th>
                  <th className="p-2 text-right">ORYXX</th>
                  <th className="p-2 text-right">Baseline</th>
                  <th className="p-2 text-right">Cost Δ</th>
                  <th className="p-2 text-right">Stale %</th>
                </tr>
              </thead>
              <tbody>
                {sweep.map((s, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-2">{s.windowSec}s</td>
                    <td className="p-2 text-right">{s.newlyDiscoverableCount}</td>
                    <td className="p-2 text-right text-green-600">{s.oryxxWins}</td>
                    <td className="p-2 text-right text-red-600">{s.baselineWins}</td>
                    <td className="p-2 text-right">{s.meanCostDelta}</td>
                    <td className="p-2 text-right">{(s.staleRate * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {invariant && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3">Zero-Inventory Invariant Check</h3>
          <p className="text-xs text-muted-foreground mb-3">
            If all free_bikes are set to 0, ORYXX should become equivalent to baseline (0 newly discoverable routes).
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="With live inventory — newly discoverable" value={invariant.withLiveInventory?.newlyDiscoverableCount} />
            <Stat label="With zero inventory — newly discoverable" value={invariant.withZeroInventory?.newlyDiscoverableCount} />
            <Stat label="Invariant holds" value={invariant.invariantHolds ? "YES" : "NO"} color={invariant.invariantHolds ? "text-green-600" : "text-red-600"} />
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, suffix = "", icon: Icon, color = "" }: { label: string; value: any; suffix?: string; icon?: any; color?: string }) {
  return (
    <div className="p-3 rounded border">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />} {label}
      </div>
      <div className={`text-lg font-semibold mt-1 ${color}`}>{value}{suffix}</div>
    </div>
  );
}
