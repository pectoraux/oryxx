// ORYXX — OSM Nominatim Reverse Geocoding API
//
// GET /api/oryxx/reverse-geocode?lat=<float>&lon=<float>
//   → 200 { result: GeocodeResult | null }   (null when Nominatim has no name)
//   → 400 { error: "<bad input message>" }
//   → 502 { error: "<upstream message>" }
//
// Reality: the result comes from the live OSM Nominatim reverse endpoint
// via osmGeocoder.reverseGeocode(). If the upstream is rate-limited,
// offline, or has no result for the requested coordinate, the adapter
// returns null — the caller sees a clean null, never a fabricated name.

import { NextResponse } from "next/server";
import { osmGeocoder } from "@/lib/oryxx/live/adapters/data-source-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const latStr = url.searchParams.get("lat");
    const lonStr = url.searchParams.get("lon");

    if (latStr === null || lonStr === null) {
      return NextResponse.json(
        { error: "Missing 'lat' and/or 'lon' parameter." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const lat = Number(latStr);
    const lon = Number(lonStr);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return NextResponse.json(
        { error: "'lat' and 'lon' must be finite numbers." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (lat < -90 || lat > 90) {
      return NextResponse.json(
        { error: "'lat' out of range (must be -90..90)." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (lon < -180 || lon > 180) {
      return NextResponse.json(
        { error: "'lon' out of range (must be -180..180)." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const result = await osmGeocoder.reverseGeocode({ lat, lon });

    return NextResponse.json(
      {
        result,
        provenance: osmGeocoder.getProvenance(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: `Reverse geocoding failed: ${err?.message || String(err)}` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
