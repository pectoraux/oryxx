"use client";

// ORYXX — Marketplace Console (SANDBOX)
//
// This console drives the live marketplace pipeline end-to-end in SANDBOX
// environment. It is explicitly labeled "SANDBOX MARKET" — not live commerce.
// Sandbox execution CANNOT produce W3-M/W4-M evidence.

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, Activity, Package, Truck, Zap, DollarSign, Radio,
  AlertCircle, CheckCircle2,
} from "lucide-react";

interface Overview {
  demands: number;
  supplies: number;
  opportunities: number;
  executions: number;
  broadcasts: number;
}

interface Provider {
  identity: { providerId: string; type: string; name: string; environment: string; connectionStatus: string };
  capabilities: Record<string, boolean>;
  resourceCount: number;
}

export function MarketplaceConsole() {
  const { toast } = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [demands, setDemands] = useState<any[]>([]);
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  const [broadcasts, setBroadcasts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ovRes, provRes, demRes, oppRes, exeRes, bcastRes] = await Promise.all([
        fetch("/api/oryxx/marketplace"),
        fetch("/api/oryxx/marketplace?view=providers"),
        fetch("/api/oryxx/marketplace?view=demands"),
        fetch("/api/oryxx/marketplace?view=opportunities"),
        fetch("/api/oryxx/marketplace?view=executions"),
        fetch("/api/oryxx/marketplace?view=broadcasts"),
      ]);
      const ov = await ovRes.json();
      const prov = await provRes.json();
      const dem = await demRes.json();
      const opp = await oppRes.json();
      const exe = await exeRes.json();
      const bcast = await bcastRes.json();
      setOverview(ov.overview || null);
      setProviders(prov.providers || []);
      setDemands(dem.demands || []);
      setOpportunities(opp.opportunities || []);
      setExecutions(exe.executions || []);
      setBroadcasts(bcast.broadcasts || []);
    } catch (e) {
      toast({ title: "Failed to load marketplace data", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const callApi = async (mode: string, extra: any = {}) => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/oryxx/marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({ title: mode, description: data.message || "OK" });
      await fetchAll();
    } catch (e) {
      toast({ title: `${mode} failed`, description: String(e), variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* SANDBOX disclaimer — always visible */}
      <Card className="p-4 border-blue-300 bg-blue-50 dark:bg-blue-950/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <h3 className="font-semibold text-blue-900 dark:text-blue-200">SANDBOX MARKET</h3>
            <p className="text-sm text-blue-800 dark:text-blue-300">
              This is a sandbox marketplace. No live provider integrations are connected.
              Sandbox transactions use deterministic fixture data. Sandbox execution
              <strong> cannot</strong> produce W3-M/W4-M marketplace evidence.
            </p>
          </div>
        </div>
      </Card>

      {/* Overview */}
      {overview && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Activity className="h-4 w-4" /> Marketplace Overview</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat icon={Package} label="Demands" value={overview.demands} />
            <Stat icon={Truck} label="Supplies" value={overview.supplies} />
            <Stat icon={Zap} label="Opportunities" value={overview.opportunities} />
            <Stat icon={CheckCircle2} label="Executions" value={overview.executions} />
            <Stat icon={Radio} label="Broadcasts" value={overview.broadcasts} />
          </div>
        </Card>
      )}

      {/* Vertical slice — create demand → discover → clear → execute */}
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-medium flex items-center gap-2"><Zap className="h-4 w-4" /> Sandbox Vertical Slice</h3>
        <p className="text-xs text-muted-foreground">
          Run the full marketplace pipeline end-to-end: demand → supply discovery → opportunity evaluation → market clearing → payment → execution.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => callApi("create_demand")} disabled={actionLoading} size="sm">
            {actionLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Package className="h-4 w-4 mr-1" />}
            1. Create Demand
          </Button>
        </div>
      </Card>

      {/* Providers */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Provider Registry</h3>
        {providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No providers registered.</p>
        ) : (
          <div className="space-y-2">
            {providers.map((p) => (
              <div key={p.identity.providerId} className="flex items-center justify-between p-2 rounded border text-xs">
                <div>
                  <span className="font-medium">{p.identity.name}</span>
                  <span className="text-muted-foreground ml-2">({p.identity.providerId})</span>
                </div>
                <div className="flex gap-2">
                  <Badge variant={p.identity.environment === "SANDBOX" ? "default" : "secondary"}>{p.identity.environment}</Badge>
                  <Badge variant="outline">{p.identity.connectionStatus}</Badge>
                  <Badge variant="outline">{p.resourceCount} resources</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Demands */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Demands</h3>
        {demands.length === 0 ? (
          <p className="text-xs text-muted-foreground">No demands. Create one above.</p>
        ) : (
          <ScrollArea className="max-h-48">
            <div className="space-y-1">
              {demands.slice(0, 10).map((d) => (
                <div key={d.id} className="flex items-center justify-between p-2 rounded border text-xs">
                  <div className="font-mono">{d.id.substring(0, 12)}…</div>
                  <div className="flex gap-2">
                    <Badge variant="outline">{d.kind}</Badge>
                    <Badge variant="outline">{d.requestType}</Badge>
                    <Badge variant={d.status === "OPEN" ? "default" : "secondary"}>{d.status}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => callApi("discover_supply", { demandId: d.id })} disabled={actionLoading}>
                      Discover Supply
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Opportunities */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Opportunities</h3>
        {opportunities.length === 0 ? (
          <p className="text-xs text-muted-foreground">No opportunities. Discover supply + opportunities first.</p>
        ) : (
          <ScrollArea className="max-h-48">
            <div className="space-y-1">
              {opportunities.slice(0, 10).map((o) => (
                <div key={o.id} className="flex items-center justify-between p-2 rounded border text-xs">
                  <div>
                    <span className="font-mono">{o.id.substring(0, 12)}…</span>
                    <span className="text-muted-foreground ml-2">${(o.price / 100).toFixed(2)}</span>
                    <span className="text-muted-foreground ml-2">{o.distanceKm.toFixed(1)}km</span>
                  </div>
                  <div className="flex gap-2">
                    <Badge variant={o.status === "ACCEPTED" ? "default" : "secondary"}>{o.status}</Badge>
                    {(o.status === "DISCOVERED" || o.status === "EVALUATED") && (
                      <Button size="sm" variant="ghost" onClick={() => callApi("clear_market", { demandId: o.demandId })} disabled={actionLoading}>
                        Clear Market
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Executions */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Executions</h3>
        {executions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No executions. Clear market first.</p>
        ) : (
          <ScrollArea className="max-h-48">
            <div className="space-y-1">
              {executions.slice(0, 10).map((e) => (
                <div key={e.id} className="flex items-center justify-between p-2 rounded border text-xs">
                  <div>
                    <span className="font-mono">{e.id.substring(0, 12)}…</span>
                    <span className="text-muted-foreground ml-2">{e.state}</span>
                  </div>
                  <div className="flex gap-2">
                    <Badge variant={e.evidenceEligible ? "default" : "secondary"}>
                      {e.evidenceEligible ? "Evidence-eligible" : "Not evidence-eligible"}
                    </Badge>
                    {e.state === "ACCEPTED" && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => callApi("authorize_payment", { agreementId: e.agreementId })} disabled={actionLoading}>
                          Authorize Payment
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => callApi("complete_execution", { executionId: e.id })} disabled={actionLoading}>
                          Complete
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Availability Broadcasts */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Radio className="h-4 w-4" /> Availability Broadcasts (NPD / Latent Supply)</h3>
        <Button onClick={() => callApi("broadcast_availability")} disabled={actionLoading} size="sm" className="mb-3">
          Create Broadcast
        </Button>
        {broadcasts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No broadcasts.</p>
        ) : (
          <ScrollArea className="max-h-32">
            <div className="space-y-1">
              {broadcasts.slice(0, 5).map((b) => (
                <div key={b.id} className="flex items-center justify-between p-2 rounded border text-xs">
                  <div className="font-mono">{b.id.substring(0, 12)}…</div>
                  <div className="flex gap-2">
                    <Badge variant="outline">{b.status}</Badge>
                    <Badge variant={b.isCommitted ? "default" : "secondary"}>
                      {b.isCommitted ? "COMMITTED" : "POTENTIAL"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </Card>

      {/* Evidence boundary */}
      <Card className="p-3 border-amber-300 bg-amber-50 dark:bg-amber-950/20">
        <p className="text-xs text-amber-800 dark:text-amber-300">
          <strong>Evidence Boundary:</strong> Marketplace transactions are tagged
          <code className="mx-1 px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900">isMarketplaceOpportunity=true</code>
          and
          <code className="mx-1 px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900">researchStimulus=false</code>
          Research stimuli (W3-R/W4-R) can never become marketplace evidence, and vice versa.
          Sandbox execution is
          <code className="mx-1 px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900">evidenceEligible=false</code>
          and cannot produce W3-M/W4-M.
        </p>
      </Card>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <div className="p-3 rounded border">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}
