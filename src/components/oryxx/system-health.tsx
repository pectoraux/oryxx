"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Activity,
  Database,
  Globe,
  Server,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Network,
} from "lucide-react";

interface SubsystemReport {
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  detail?: unknown;
  error?: string | null;
}

interface DataSourceSummary {
  id: string;
  kind: string;
  environment: string;
  dataSource: string;
  coverage: string;
  lastUpdated: string | null;
  lastError: string | null;
  status: string;
}

interface ProviderDetail {
  providerId: string;
  name: string;
  type: string;
  environment: string;
  connectionStatus: string;
  capabilities: Record<string, boolean>;
  resourceCount: number;
  healthCheck?: { connected: boolean; latencyMs?: number; stationCount?: number; timestamp?: string; error?: string | null };
}

interface HealthResponse {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  version: string;
  subsystems: {
    database: SubsystemReport;
    dataSources: SubsystemReport;
    providers: SubsystemReport;
    graph: SubsystemReport;
  };
}

const STATUS_META: Record<string, { icon: any; color: string; label: string }> = {
  ok: { icon: CheckCircle2, color: "text-emerald-600", label: "OK" },
  degraded: { icon: AlertTriangle, color: "text-amber-600", label: "DEGRADED" },
  down: { icon: XCircle, color: "text-destructive", label: "DOWN" },
};

export function SystemHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok && res.status !== 503) {
        throw new Error(`Health returned ${res.status}`);
      }
      const data: HealthResponse = await res.json();
      setHealth(data);
    } catch (e) {
      setError((e as Error)?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, 30_000);
    return () => clearInterval(id);
  }, [fetchHealth]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-600" />
            <h2 className="text-sm font-semibold">Production Health</h2>
            <Badge variant="outline" className="text-[10px]">auto-refresh 30s</Badge>
          </div>
          <Button size="sm" variant="ghost" onClick={fetchHealth} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1 text-xs">Refresh</span>
          </Button>
        </div>
        {health && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span>Overall:</span>
            <StatusBadge status={health.status} />
            <Separator orientation="vertical" className="h-4" />
            <span>version {health.version}</span>
            <Separator orientation="vertical" className="h-4" />
            <span className="font-mono">{health.timestamp}</span>
          </div>
        )}
        {error && (
          <div className="mt-3 flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </div>
        )}
      </Card>

      {health && (
        <div className="grid gap-3 md:grid-cols-2">
          <SubsystemCard
            icon={Database}
            title="Database"
            report={health.subsystems.database}
            render={() => (
              <div className="text-[11px] text-muted-foreground">
                {typeof health.subsystems.database.detail === "object" &&
                health.subsystems.database.detail !== null ? (
                  <span>
                    {(health.subsystems.database.detail as any).userCount ?? 0} users ·{" "}
                    {health.subsystems.database.latencyMs ?? 0}ms
                  </span>
                ) : (
                  <span>{health.subsystems.database.error ?? "no detail"}</span>
                )}
              </div>
            )}
          />

          <SubsystemCard
            icon={Globe}
            title="Real Data Sources"
            report={health.subsystems.dataSources}
            render={() => {
              const sources = (health.subsystems.dataSources.detail as DataSourceSummary[]) ?? [];
              return (
                <div className="space-y-1.5">
                  {sources.map((s) => (
                    <div key={s.id} className="rounded-md border bg-muted/30 px-2 py-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium">{s.dataSource}</span>
                        <StatusBadge status={s.status as any} />
                      </div>
                      <div className="mt-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>{s.kind} · {s.environment}</span>
                        <span>{s.coverage}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/80">
                        {s.lastUpdated ? `updated ${new Date(s.lastUpdated).toLocaleTimeString()}` : "never called"}
                        {s.lastError ? ` · ${s.lastError}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              );
            }}
          />

          <SubsystemCard
            icon={Server}
            title="Transportation Providers"
            report={health.subsystems.providers}
            render={() => {
              const providers = (health.subsystems.providers.detail as ProviderDetail[]) ?? [];
              if (providers.length === 0) {
                return <div className="text-[11px] text-muted-foreground">No providers registered.</div>;
              }
              return (
                <div className="space-y-1.5">
                  {providers.map((p) => (
                    <div key={p.providerId} className="rounded-md border bg-muted/30 px-2 py-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium">{p.name}</span>
                        <Badge variant="outline" className="text-[9px]">{p.connectionStatus}</Badge>
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {p.type} · {p.environment} · {p.resourceCount} resources
                      </div>
                      {p.healthCheck && (
                        <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/80">
                          {p.healthCheck.connected ? (
                            <span className="text-emerald-700 dark:text-emerald-400">
                              ✓ live · {p.healthCheck.latencyMs}ms · {p.healthCheck.stationCount ?? 0} stations
                            </span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400">
                              ✗ {p.healthCheck.error ?? "not connected"}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {Object.entries(p.capabilities).filter(([, v]) => v).map(([k]) => (
                          <Badge key={k} variant="secondary" className="text-[8px]">{k}</Badge>
                        ))}
                        {Object.entries(p.capabilities).filter(([, v]) => v).length === 0 && (
                          <span className="text-[9px] text-muted-foreground/60">no transactional capabilities</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            }}
          />

          <SubsystemCard
            icon={Network}
            title="Transportation Graph"
            report={health.subsystems.graph}
            render={() => {
              const d = health.subsystems.graph.detail as { nodeCount: number; edgeCount: number; note: string } | undefined;
              return (
                <div className="space-y-1">
                  <div className="text-[11px] text-muted-foreground">
                    nodes: <span className="font-mono text-foreground">{d?.nodeCount ?? 0}</span> ·{" "}
                    edges: <span className="font-mono text-foreground">{d?.edgeCount ?? 0}</span>
                  </div>
                  <div className="text-[10px] leading-relaxed text-muted-foreground/80">{d?.note}</div>
                </div>
              );
            }}
          />
        </div>
      )}

      <Card className="p-3">
        <div className="text-[10px] leading-relaxed text-muted-foreground/70">
          <strong>Reality labels:</strong> SANDBOX = in-process, transactional but not real ·
          OBSERVED_ONLY = reads a real external system but cannot transact ·
          SIMULATED = deterministic synthetic data · FIXTURE = static test data ·
          LIVE = real transactional integration (none at HEAD).
        </div>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: "ok" | "degraded" | "down" }) {
  const meta = STATUS_META[status] ?? STATUS_META.down;
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={`text-[9px] ${meta.color}`}>
      <Icon className="mr-1 h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

function SubsystemCard({
  icon: Icon,
  title,
  report,
  render,
}: {
  icon: any;
  title: string;
  report: SubsystemReport;
  render: () => React.ReactNode;
}) {
  const meta = STATUS_META[report.status] ?? STATUS_META.down;
  const SIcon = meta.icon;
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <Badge variant="outline" className={`text-[9px] ${meta.color}`}>
          <SIcon className="mr-1 h-3 w-3" />
          {meta.label}
        </Badge>
      </div>
      {render()}
    </Card>
  );
}
