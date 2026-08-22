// ORYXX GTFS transit adapter API.
// GET  /api/oryxx/transit
//      ?lat=<lat>&lon=<lon>&radiusKm=<km>&limit=<n>
//      → { stops: Array<{ stop: GtfsStop; nextDepartures: GtfsDeparture[]; supply: TransportationSupply }>, feed: GtfsFeedMeta }
// GET  /api/oryxx/transit  (no params)
//      → { feed: GtfsFeedMeta }   (feed status only — does NOT trigger a load)
// POST /api/oryxx/transit?action=reload   (admin-gated)
//      → { ok: true, feed: GtfsFeedMeta }  (forces a fresh download)
//
// Behavior:
//   - The first GET with query params triggers a NON-BLOCKING background
//     feed load and returns 504 with a hint (the feed takes ~12-15s to load).
//   - Subsequent GETs return real stops + departures once the feed is ready.
//   - Bad input → 400.
//   - Upstream feed failure (download/parse) → 502.
//   - Unknown lat/lon/radiusKm/limit combination → empty stops, NOT an error.
//
// Auth:
//   - GET: anonymous (read-only observed data; safe to expose).
//   - POST ?action=reload: requires authenticated admin session (role === "admin").
//     NOTE: this is a no-auth-for-now convenience for development; in production
//     this MUST be gated by an explicit admin role check (which we do enforce).

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { gtfsTransit } from "@/lib/oryxx/live/adapters/gtfs-transit";
import type { GtfsDeparture, GtfsFeedMeta, GtfsStop } from "@/lib/oryxx/live/adapters/gtfs-transit";
import type { TransportationSupply } from "@/lib/oryxx/live/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ═══════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════

const MAX_RADIUS_KM = 50;
const MAX_LIMIT = 50;
const DEFAULT_RADIUS_KM = 1;
const DEFAULT_LIMIT = 5;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

function parseLat(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < -90 || n > 90) return null;
  return n;
}

function parseLon(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < -180 || n > 180) return null;
  return n;
}

function parseRadiusKm(v: string | null): number {
  if (v === null) return DEFAULT_RADIUS_KM;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return Math.min(n, MAX_RADIUS_KM);
}

function parseLimit(v: string | null): number {
  if (v === null) return DEFAULT_LIMIT;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return Math.min(n, MAX_LIMIT);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function feedMetaResponse(): { feed: GtfsFeedMeta } {
  return { feed: gtfsTransit.getFeedMeta() };
}

/**
 * Build the response for a "find stops near point" query. Assumes the feed
 * is already loaded — callers should check `gtfsTransit.isReady()` first
 * and return 504 if not.
 */
async function buildStopsResponse(
  lat: number,
  lon: number,
  radiusKm: number,
  limit: number,
): Promise<NextResponse> {
  const point = { lat, lon };
  const stops = gtfsTransit.getStopsNear(point, radiusKm);

  // Cap the number of stops returned to avoid huge responses on dense feeds
  // (e.g., MBTA has 10k+ stops; a 5km query in central Boston could return
  // hundreds). 25 stops × N departures each is plenty for any UI.
  const MAX_STOPS = 25;
  const cappedStops = stops.slice(0, MAX_STOPS);

  const nowSec = Math.floor(Date.now() / 1000) % 86_400;

  const enrichedStops = await Promise.all(
    cappedStops.map(async (stop: GtfsStop) => {
      const departures: GtfsDeparture[] = await gtfsTransit.getNextDepartures(
        stop.stopId,
        nowSec,
        limit,
      );
      const supply: TransportationSupply | null =
        departures.length > 0 ? gtfsTransit.toTransportationSupply(stop, departures) : null;
      return { stop, nextDepartures: departures, supply };
    }),
  );

  return NextResponse.json({
    stops: enrichedStops,
    feed: gtfsTransit.getFeedMeta(),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// GET HANDLER
// ═══════════════════════════════════════════════════════════════════════

export async function GET(req: Request) {
  const url = new URL(req.url);
  const latRaw = url.searchParams.get("lat");
  const lonRaw = url.searchParams.get("lon");
  const radiusRaw = url.searchParams.get("radiusKm");
  const limitRaw = url.searchParams.get("limit");

  // No params → return feed status only (does NOT trigger a load).
  if (latRaw === null && lonRaw === null) {
    return NextResponse.json(feedMetaResponse());
  }

  // Validate inputs.
  if (latRaw === null || lonRaw === null) {
    return bad("Both `lat` and `lon` are required (or omit both for feed status).");
  }
  const lat = parseLat(latRaw);
  const lon = parseLon(lonRaw);
  if (lat === null) return bad(`Invalid \`lat\`: must be a number in [-90, 90]. Got: ${latRaw}`);
  if (lon === null) return bad(`Invalid \`lon\`: must be a number in [-180, 180]. Got: ${lonRaw}`);
  const radiusKm = parseRadiusKm(radiusRaw);
  if (Number.isNaN(radiusKm)) return bad(`Invalid \`radiusKm\`: must be a positive number. Got: ${radiusRaw}`);
  const limit = parseLimit(limitRaw);
  if (Number.isNaN(limit)) return bad(`Invalid \`limit\`: must be a positive integer. Got: ${limitRaw}`);

  // If the feed is not ready yet, kick off a background load (non-blocking)
  // and return 504 with a hint. The client can retry in ~15s.
  if (!gtfsTransit.isReady()) {
    // Only kick off the background load if there isn't one already in flight
    // and the previous attempt failed (so we don't hammer the upstream feed).
    gtfsTransit.ensureFeedLoaded();

    const meta = gtfsTransit.getFeedMeta();
    if (meta.lastError) {
      // Previous load attempt failed — return 502 so the client knows upstream is broken.
      return NextResponse.json(
        {
          error: "GTFS feed unavailable.",
          detail: meta.lastError,
          hint: "The feed failed to load. POST ?action=reload (admin) to retry.",
          feed: meta,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        error: "GTFS feed is still loading.",
        hint: "Retry in ~15 seconds. The first request triggers a non-blocking background download + parse (~12-15s for the MBTA feed).",
        feed: meta,
      },
      { status: 504 },
    );
  }

  try {
    return await buildStopsResponse(lat, lon, radiusKm, limit);
  } catch (err) {
    console.error("[oryxx/transit] GET error:", err);
    return NextResponse.json(
      {
        error: "Transit query failed.",
        detail: (err as Error)?.message ?? String(err),
        feed: gtfsTransit.getFeedMeta(),
      },
      { status: 500 },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// POST HANDLER — admin-gated reload
// ═══════════════════════════════════════════════════════════════════════

export async function POST(req: Request) {
  // Auth: require an authenticated admin session.
  const session = await getServerSession(authOptions);
  const role = (session?.user as any)?.role as string | undefined;
  if (!session || role !== "admin") {
    return bad("Admin authentication required.", 403);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action !== "reload") {
    return bad(`Unknown POST action: ${action ?? "(none)"}. Supported: action=reload.`);
  }

  try {
    // Clear the cache and trigger a fresh load (blocking — admin wants the result).
    gtfsTransit.clearCache();
    const result = await gtfsTransit.loadFeed();
    return NextResponse.json({
      ok: true,
      loaded: result,
      feed: gtfsTransit.getFeedMeta(),
    });
  } catch (err) {
    console.error("[oryxx/transit] POST reload error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Feed reload failed.",
        detail: (err as Error)?.message ?? String(err),
        feed: gtfsTransit.getFeedMeta(),
      },
      { status: 502 },
    );
  }
}
