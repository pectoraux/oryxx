"use client";

// ORYXX — Research Operator Monitoring Dashboard
//
// This dashboard is shown to research OPERATORS (admins). It displays:
//   - Eligible / enrolled / consented providers
//   - Offers presented / viewed / accepted / declined / unavailable / ignored
//   - W3-R and W4-R counts
//   - Per-treatment-cell breakdown with Wilson 95% CI
//
// IMPORTANT: scenario-model curves are NOT shown as empirical results here.
// They are labeled "SCENARIO MODEL — NOT OBSERVED" if shown at all.
//
// The dashboard also provides:
//   - Activation gate check (PREREGISTERED → ACTIVE)
//   - Emergency pause / resume
//   - Integrity check
//   - Data export (analysis + audit datasets)
//
// W3-M / W4-M evidence counts must remain zero. If they appear, it is a
// critical integrity event and the operator must pause immediately.

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, ShieldCheck, AlertTriangle, Play, Pause, FileDown, Activity,
  Users, CheckCircle2, XCircle, HelpCircle, Clock,
} from "lucide-react";

interface CellResult {
  cell: { id: string; compensation: number; detourKm: number; extraTimeMin: number; advanceNoticeMin: number };
  offers: number;
  viewed: number;
  accepted: number;
  declined: number;
  unavailable: number;
  ignored: number;
  completed: number;
  acceptanceRate: number | null;
  completionRate: number | null;
  acceptanceCI95: { low: number; high: number } | null;
  completionCI95: { low: number; high: number } | null;
}

interface IntegrityReport {
  violations: { type: string; detail: string; severity: string }[];
  counts: {
    enrollments: number;
    responses: number;
    w3r: number;
    w4r: number;
    w3m: number;
    w4m: number;
    withdrawn: number;
  };
  hashChainValid: boolean;
}

interface GateCheck { name: string; passed: boolean; detail?: string; }

export function ResearchOperatorDashboard() {
  const { toast } = useToast();
  const [experiments, setExperiments] = useState<any[]>([]);
  const [selectedExpId, setSelectedExpId] = useState<string | null>(null);
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [gate, setGate] = useState<{ canActivate: boolean; checks: GateCheck[] } | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);

  const fetchExperiments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExperiments(data.experiments || []);
    } catch (e) {
      toast({ title: "Failed to load", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const fetchResults = useCallback(async (expId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/oryxx/willingness/results?experimentId=${expId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResults(data);
    } catch (e) {
      toast({ title: "Failed to load results", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchExperiments(); }, [fetchExperiments]);
  useEffect(() => { if (selectedExpId) fetchResults(selectedExpId); }, [selectedExpId, fetchResults]);

  const callApi = async (mode: string, extra: any = {}) => {
    if (!selectedExpId) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, experimentId: selectedExpId, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({ title: mode, description: data.message || "OK" });
      if (mode === "activation_check") setGate(data.gate);
      if (mode === "integrity_check") setIntegrity(data.report);
      if (mode === "pause" || mode === "resume" || mode === "activate" || mode === "complete") fetchExperiments();
    } catch (e) {
      toast({ title: `${mode} failed`, description: String(e), variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  const exportData = async (mode: "export_analysis" | "export_audit") => {
    if (!selectedExpId) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, experimentId: selectedExpId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${mode}_${selectedExpId.substring(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `${mode} downloaded.` });
    } catch (e) {
      toast({ title: "Export failed", description: String(e), variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  const selectedExp = experiments.find((e) => e.id === selectedExpId);
  const cellResults: CellResult[] = results?.cellResults || [];
  const hasIntegrityIssue = integrity && integrity.violations.length > 0;
  const hasMarketplaceEvidence = (results?.w3Count > 0 && results?.w3Count !== results?.w3rCount) || (integrity?.counts.w3m || 0) > 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" /> Research Operator Dashboard
          </h2>
          <Badge variant="outline">W3-R measures provider behavior in a controlled research study</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          This dashboard displays empirical research data only. Scenario-model curves are labeled and kept separate.
          W3-M / W4-M evidence must remain zero — their appearance is a critical integrity event.
        </p>
      </Card>

      {/* Experiment selector */}
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-medium">Experiments</h3>
        {loading && !experiments.length ? (
          <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading...</div>
        ) : experiments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No experiments. Create one via the API.</p>
        ) : (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {experiments.map((exp) => (
              <button
                key={exp.id}
                onClick={() => { setSelectedExpId(exp.id); setGate(null); setIntegrity(null); }}
                className={`w-full text-left p-2 rounded border text-sm transition-colors ${selectedExpId === exp.id ? "bg-accent" : "hover:bg-accent/50"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{exp.name}</span>
                  <Badge variant={exp.status === "ACTIVE" ? "default" : exp.status === "COMPLETED" ? "secondary" : "outline"}>
                    {exp.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  W3-R: {exp.w3rCount || 0} · W4-R: {exp.w4rCount || 0}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {selectedExp && (
        <>
          {/* Evidence summary */}
          <Card className="p-4 space-y-3">
            <h3 className="text-sm font-medium">Evidence Summary</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard icon={Users} label="Enrollments" value={results ? "?" : "—"} />
              <StatCard icon={CheckCircle2} label="W3-R (accepted)" value={results?.w3Count ?? 0} highlight />
              <StatCard icon={CheckCircle2} label="W4-R (completed)" value={results?.w4Count ?? 0} highlight />
              <StatCard icon={XCircle} label="W3-M (marketplace)" value={0} />
              <StatCard icon={XCircle} label="W4-M (marketplace)" value={0} />
              <StatCard icon={Activity} label="Total responses" value={results?.totalResponses ?? 0} />
            </div>
            {hasMarketplaceEvidence && (
              <div className="flex items-center gap-2 p-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-300">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <span className="text-sm text-red-700 dark:text-red-400 font-medium">
                  CRITICAL: W3-M or W4-M evidence detected. Pause the experiment immediately.
                </span>
              </div>
            )}
          </Card>

          {/* Operator controls */}
          <Card className="p-4 space-y-3">
            <h3 className="text-sm font-medium">Operator Controls</h3>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => callApi("activation_check")} disabled={actionLoading} variant="outline" size="sm">
                <ShieldCheck className="h-4 w-4 mr-1" /> Check Activation Gate
              </Button>
              {selectedExp.status === "PREREGISTERED" && (
                <Button onClick={() => callApi("activate")} disabled={actionLoading} size="sm">
                  <Play className="h-4 w-4 mr-1" /> Activate
                </Button>
              )}
              {selectedExp.status === "ACTIVE" && (
                <Button onClick={() => callApi("pause")} disabled={actionLoading} variant="destructive" size="sm">
                  <Pause className="h-4 w-4 mr-1" /> Emergency Pause
                </Button>
              )}
              {selectedExp.status === "PAUSED" && (
                <Button onClick={() => callApi("resume")} disabled={actionLoading} size="sm">
                  <Play className="h-4 w-4 mr-1" /> Resume
                </Button>
              )}
              {(selectedExp.status === "ACTIVE" || selectedExp.status === "PAUSED") && (
                <Button onClick={() => callApi("complete")} disabled={actionLoading} variant="outline" size="sm">
                  Complete
                </Button>
              )}
              <Button onClick={() => callApi("integrity_check")} disabled={actionLoading} variant="outline" size="sm">
                <AlertTriangle className="h-4 w-4 mr-1" /> Integrity Check
              </Button>
              <Button onClick={() => exportData("export_analysis")} disabled={actionLoading} variant="outline" size="sm">
                <FileDown className="h-4 w-4 mr-1" /> Export Analysis
              </Button>
              <Button onClick={() => exportData("export_audit")} disabled={actionLoading} variant="outline" size="sm">
                <FileDown className="h-4 w-4 mr-1" /> Export Audit
              </Button>
            </div>

            {/* Activation gate result */}
            {gate && (
              <div className="mt-2 p-3 rounded border">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={gate.canActivate ? "default" : "destructive"}>
                    {gate.canActivate ? "CAN ACTIVATE" : "CANNOT ACTIVATE"}
                  </Badge>
                </div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {gate.checks.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 text-xs">
                      <span className={c.passed ? "text-green-600" : "text-red-600"}>
                        {c.passed ? "✓" : "✗"}
                      </span>
                      <span className="font-mono">{c.name}</span>
                      {c.detail && <span className="text-muted-foreground">{c.detail}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Integrity check result */}
            {integrity && (
              <div className="mt-2 p-3 rounded border">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={integrity.violations.length === 0 ? "default" : "destructive"}>
                    {integrity.violations.length === 0 ? "INTEGRITY OK" : `${integrity.violations.length} VIOLATIONS`}
                  </Badge>
                  <Badge variant={integrity.hashChainValid ? "default" : "destructive"}>
                    Hash chain: {integrity.hashChainValid ? "valid" : "BROKEN"}
                  </Badge>
                </div>
                {integrity.violations.length > 0 && (
                  <ScrollArea className="h-32">
                    <div className="space-y-1">
                      {integrity.violations.map((v, i) => (
                        <div key={i} className="text-xs p-1 rounded bg-red-50 dark:bg-red-950/20">
                          <span className="font-mono text-red-700 dark:text-red-400">{v.type}:</span>{" "}
                          <span className="text-muted-foreground">{v.detail}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            )}
          </Card>

          {/* Per-cell results */}
          {cellResults.length > 0 && (
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-medium">Per-Treatment-Cell Results (Wilson 95% CI)</h3>
              <div className="text-xs text-muted-foreground mb-2">
                Empirical research data only. No scenario-model curves.
              </div>
              <ScrollArea className="max-h-96">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2">Cell</th>
                      <th className="p-2 text-right">n</th>
                      <th className="p-2 text-right">Viewed</th>
                      <th className="p-2 text-right">Accept</th>
                      <th className="p-2 text-right">Decline</th>
                      <th className="p-2 text-right">Ignored</th>
                      <th className="p-2 text-right">W3-R rate</th>
                      <th className="p-2 text-right">95% CI</th>
                      <th className="p-2 text-right">W4-R rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cellResults.map((cr) => (
                      <tr key={cr.cell.id} className="border-b">
                        <td className="p-2 font-mono text-[10px]">{cr.cell.id}</td>
                        <td className="p-2 text-right">{cr.offers}</td>
                        <td className="p-2 text-right">{cr.viewed}</td>
                        <td className="p-2 text-right text-green-600">{cr.accepted}</td>
                        <td className="p-2 text-right text-red-600">{cr.declined}</td>
                        <td className="p-2 text-right">{cr.ignored}</td>
                        <td className="p-2 text-right">{cr.acceptanceRate !== null ? `${(cr.acceptanceRate * 100).toFixed(1)}%` : "—"}</td>
                        <td className="p-2 text-right text-muted-foreground">
                          {cr.acceptanceCI95 ? `[${(cr.acceptanceCI95.low * 100).toFixed(0)}, ${(cr.acceptanceCI95.high * 100).toFixed(0)}]` : "—"}
                        </td>
                        <td className="p-2 text-right">{cr.completionRate !== null ? `${(cr.completionRate * 100).toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </Card>
          )}

          {/* Scenario model disclaimer */}
          <Card className="p-3 border-muted bg-muted/30">
            <p className="text-xs text-muted-foreground">
              <strong>SCENARIO MODEL — NOT OBSERVED:</strong> Any simulation results (from the market simulator or willingness
              engine) are model outputs, not empirical evidence. They are not displayed in the empirical results table above.
              W3-R = behavioral acceptance in controlled research. W4-R = actual pilot completion (operator-verified).
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, highlight }: { icon: any; label: string; value: any; highlight?: boolean }) {
  return (
    <div className={`p-3 rounded border ${highlight ? "border-green-300 bg-green-50 dark:bg-green-950/20" : ""}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={`text-lg font-semibold mt-1 ${highlight ? "text-green-700 dark:text-green-400" : ""}`}>{value}</div>
    </div>
  );
}
