// ORYXX — Weather observation API (OBSERVED_ONLY)
//
// GET /api/oryxx/weather?lat=<lat>&lon=<lon>
//   → { weather: WeatherObservation | null }
//
// Validates lat ∈ [-90, 90], lon ∈ [-180, 180]; returns 400 on bad input.
// Open-Meteo weather is cacheable for ~5 minutes (the adapter also caches
// in-memory for 5 minutes), so we emit a Cache-Control: public, max-age=300.
//
// Never leaks stack traces to the client. On any upstream failure the
// adapter returns `null` (OBSERVED_ONLY — never fake).

import { NextResponse } from "next/server";
import { openMeteoWeather } from "@/lib/oryxx/live/adapters/open-meteo-weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCoord(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = parseCoord(url.searchParams.get("lat"));
  const lon = parseCoord(url.searchParams.get("lon"));

  if (
    lat === null ||
    lon === null ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return NextResponse.json(
      {
        error: "Invalid query parameters.",
        requirements: "lat ∈ [-90, 90], lon ∈ [-180, 180].",
        received: {
          lat: url.searchParams.get("lat"),
          lon: url.searchParams.get("lon"),
        },
      },
      { status: 400 },
    );
  }

  try {
    const weather = await openMeteoWeather.getWeather({ lat, lon });

    return NextResponse.json(
      { weather },
      {
        status: 200,
        headers: {
          // Weather is cacheable ~5 min upstream (Open-Meteo current weather
          // updates every ~5-15 min) and the adapter caches in-memory for
          // the same window. Allow shared caches to reuse responses.
          "Cache-Control": "public, max-age=300",
        },
      },
    );
  } catch {
    // Defensive: the adapter is designed to never throw, but if anything
    // escapes we surface a clean 502 without leaking internals.
    return NextResponse.json(
      { weather: null, error: "Weather observation unavailable." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
