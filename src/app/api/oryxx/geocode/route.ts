// ORYXX — OSM Nominatim Geocoding API
//
// GET /api/oryxx/geocode?query=<place>
//   → 200 { results: GeocodeResult[] }              (may be empty array)
//   → 400 { error: "Missing or empty 'query' parameter." }
//   → 502 { error: "<upstream message>" }            (any adapter exception)
//
// Reality: results come from the live OSM Nominatim API via osmGeocoder.
// If the upstream is rate-limited (HTTP 429), offline, or unreachable, the
// adapter returns [] — the caller sees a clean empty list, never fake
// coordinates. This route wraps unexpected adapter exceptions as 502 so
// the client always gets a JSON envelope.
//
// Cache-Control: no-store — geocoding results are environment-sensitive
// (user input varies) and the adapter already maintains its own TTL cache.

import { NextResponse } from "next/server";
import { osmGeocoder } from "@/lib/oryxx/live/adapters/data-source-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const query = (url.searchParams.get("query") ?? "").trim();

    if (!query) {
      return NextResponse.json(
        { error: "Missing or empty 'query' parameter." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (query.length > 500) {
      return NextResponse.json(
        { error: "Query too long (max 500 chars)." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const results = await osmGeocoder.geocode(query);

    return NextResponse.json(
      {
        results,
        provenance: osmGeocoder.getProvenance(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    // Defensive: the adapter is not supposed to throw, but if something
    // unexpected happens we surface a clean error (no stack trace).
    return NextResponse.json(
      { error: `Geocoding failed: ${err?.message || String(err)}` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
