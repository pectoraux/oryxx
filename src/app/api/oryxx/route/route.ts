// ORYXX — OSRM Routing API
//
// GET /api/oryxx/route?from=<lat,lon>&to=<lat,lon>&profile=walk|bike|dr
//   → 200 { route: RouteResult | null }   (null when OSRM has no route)
//   → 400 { error: "<bad input message>" }
//   → 502 { error: "<upstream message>" }
//
// Reality: the route comes from the live OSRM demo server via osrmRouter.
// OSRM coordinates are LON,LAT internally, but this API accepts the more
// conventional lat,lon format on input and converts internally.
//
// If OSRM is offline, returns 4xx/5xx for the requested profile, or has
// no route, the adapter returns null — the caller sees a clean null,
// never a fabricated distance/time. If an unexpected exception bubbles
// up, the route returns 502 with a clean message (no stack trace).
//
// Cache-Control: no-store — the adapter already maintains its own TTL cache.

import { NextResponse } from "next/server";
import { osrmRouter } from "@/lib/oryxx/live/adapters/data-source-registry";
import type { RoutingProfile } from "@/lib/oryxx/live/adapters/data-source-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PROFILES: RoutingProfile[] = ["walk", "bike", "dr"];

interface ParsedPoint {
  lat: number;
  lon: number;
}

function parsePoint(raw: string | null, name: string): ParsedPoint | null {
  if (raw === null) return null;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  void name;
  return { lat, lon };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const from = parsePoint(url.searchParams.get("from"), "from");
    const to = parsePoint(url.searchParams.get("to"), "to");
    const profileParam = (url.searchParams.get("profile") ?? "dr").trim() as RoutingProfile;

    if (!from) {
      return NextResponse.json(
        { error: "Invalid 'from' parameter. Expected format: from=<lat,lon> with -90..90 / -180..180 ranges." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!to) {
      return NextResponse.json(
        { error: "Invalid 'to' parameter. Expected format: to=<lat,lon> with -90..90 / -180..180 ranges." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!ALLOWED_PROFILES.includes(profileParam)) {
      return NextResponse.json(
        { error: `Invalid 'profile' parameter. Must be one of: ${ALLOWED_PROFILES.join(", ")}.` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const route = await osrmRouter.route([from, to], profileParam);

    return NextResponse.json(
      {
        route,
        provenance: osrmRouter.getProvenance(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: `Routing failed: ${err?.message || String(err)}` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
