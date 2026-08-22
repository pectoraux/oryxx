// ORYXX — Aggregated production health endpoint.
//
// GET /api/health  →  { status, timestamp, subsystems: { db, dataSources, providers, graph } }
//
// This is the operator-visible health surface. It probes:
//   - Database (Prisma)         : a cheap SELECT COUNT(*) on User
//   - Data sources (real)       : OSM/OSRM/GTFS — reports cached provenance, no live call
//                                  (live probes are separate per-source health endpoints)
//   - Transportation providers  : providerRegistry.status() + healthCheck() where implemented
//   - Transportation graph      : node/edge counts (currently empty — no ingestion wired)
//
// The endpoint NEVER throws. Any failing subsystem is reported as
// { status: "degraded" | "down", error: "..." } and the overall status is the
// worst of all subsystems. This is the contract for the operator dashboard and
// for uptime monitoring.
//
// Auth: not required (health checks must be callable without a session for
// liveness probes). No sensitive data is returned.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { providerRegistry } from "@/lib/oryxx/live/adapters/provider-registry";
import { dataSourceRegistry } from "@/lib/oryxx/live/adapters/data-source-registry";
import { citibikeProvider } from "@/lib/oryxx/live/adapters/citibike-provider";
import { transportGraph } from "@/lib/oryxx/live/graph/transport-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SubsystemStatus = "ok" | "degraded" | "down";

interface SubsystemReport {
  status: SubsystemStatus;
  latencyMs?: number;
  detail?: unknown;
  error?: string | null;
}

async function probeDatabase(): Promise<SubsystemReport> {
  const start = Date.now();
  try {
    // Cheap probe — count users. Times out at 3s.
    const count = await Promise.race([
      db.user.count(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("db timeout")), 3000),
      ),
    ]);
    return { status: "ok", latencyMs: Date.now() - start, detail: { userCount: count } };
  } catch (err: any) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: err?.message ?? String(err),
    };
  }
}

function probeDataSources(): SubsystemReport {
  const entries = dataSourceRegistry.list();
  const summary = entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    environment: e.environment,
    dataSource: e.dataSource,
    coverage: e.coverage,
    lastUpdated: e.lastUpdated,
    lastError: e.lastError,
    status: e.lastError ? (e.lastUpdated ? "degraded" : "down") : e.lastUpdated ? "ok" : "down",
  }));
  const anyDown = summary.some((s) => s.status === "down");
  const anyDegraded = summary.some((s) => s.status === "degraded");
  return {
    status: anyDown ? "down" : anyDegraded ? "degraded" : "ok",
    detail: summary,
  };
}

async function probeProviders(): Promise<SubsystemReport> {
  const statuses = providerRegistry.status();
  const detail: Array<Record<string, unknown>> = [];

  for (const s of statuses) {
    const entry: Record<string, unknown> = {
      providerId: s.identity.providerId,
      name: s.identity.name,
      type: s.identity.type,
      environment: s.identity.environment,
      connectionStatus: s.connectionStatus,
      capabilities: s.capabilities,
      resourceCount: s.resourceCount,
    };

    // Citi Bike has a real healthCheck() — call it (bounded).
    if (s.identity.providerId === "citi-bike-nyc") {
      try {
        const hc = await Promise.race([
          citibikeProvider.healthCheck(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("health check timeout")), 8000),
          ),
        ]);
        entry.healthCheck = {
          connected: hc.connected,
          latencyMs: hc.latencyMs,
          stationCount: hc.stationCount,
          timestamp: hc.timestamp,
          error: hc.error,
        };
      } catch (err: any) {
        entry.healthCheck = { connected: false, error: err?.message ?? String(err) };
      }
    }
    detail.push(entry);
  }

  const anyDown = detail.some(
    (d) =>
      d.connectionStatus === "ERROR" ||
      (typeof d.healthCheck === "object" && d.healthCheck !== null && (d.healthCheck as any).connected === false),
  );
  return {
    status: anyDown ? "degraded" : "ok",
    detail,
  };
}

function probeGraph(): SubsystemReport {
  // The transport graph exists but is empty at runtime — no OSM/GTFS loader
  // populates it yet. Report honestly.
  const nodes = transportGraph.nodeCount();
  const edges = transportGraph.edgeCount();
  return {
    status: nodes > 0 ? "ok" : "degraded",
    detail: {
      nodeCount: nodes,
      edgeCount: edges,
      note:
        nodes === 0
          ? "Graph is empty — no OSM/GTFS loader has populated it yet. Routing currently uses OSRM direct calls + synthetic fallback."
          : "Graph populated.",
    },
  };
}

function worst(reports: SubsystemStatus[]): SubsystemStatus {
  if (reports.includes("down")) return "down";
  if (reports.includes("degraded")) return "degraded";
  return "ok";
}

export async function GET() {
  const timestamp = new Date().toISOString();

  const [dbReport, providersReport] = await Promise.all([
    probeDatabase(),
    probeProviders(),
  ]);
  const dataSourcesReport = probeDataSources();
  const graphReport = probeGraph();

  const status = worst([
    dbReport.status,
    dataSourcesReport.status,
    providersReport.status,
    graphReport.status,
  ]);

  const httpStatus = status === "ok" ? 200 : status === "degraded" ? 200 : 503;

  return NextResponse.json(
    {
      status,
      timestamp,
      version: "0.2.1",
      subsystems: {
        database: dbReport,
        dataSources: dataSourcesReport,
        providers: providersReport,
        graph: graphReport,
      },
    },
    {
      status: httpStatus,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
