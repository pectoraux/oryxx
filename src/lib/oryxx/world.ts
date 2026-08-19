// ORYXX — The simulated WORLD.
// Three interacting graphs (master prompt §13):
//   PHYSICAL  : hubs + pairwise geometry (roads / tracks / paths / waterways)
//   SCHEDULE  : transit departures / frequencies / booking windows
//   MARKET    : live rideshare supply, dynamic pricing, latent supply (NPDs)
//
// This is a DETERMINISTIC simulated environment. The real ORYXX would ingest
// OSM, GTFS, real-time feeds, commercial APIs and a provider abstraction
// layer (§14). Here we simulate so the intelligence core is provable without
// external dependencies — and so it can never be "down".

import type { Mode, SupplySegment } from "./types";

// --- deterministic PRNG (mulberry32) so the market is stable per seed -------
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Hub {
  id: string;
  name: string;
  // abstract grid coords (km). Globally flavored but intentionally generic.
  x: number;
  y: number;
  isHarbor?: boolean;
  isAirport?: boolean;
  isPort?: boolean;
  isIndustrial?: boolean;
}

// A globally-flavored hub set. Deliberately NOT US/Euro-default (§33):
// mix of districts, infra, and informal-transit-friendly nodes.
export const HUBS: Hub[] = [
  { id: "market", name: "Market Square", x: 2, y: 8 },
  { id: "downtown", name: "Downtown Core", x: 5, y: 9 },
  { id: "university", name: "University District", x: 1, y: 6 },
  { id: "harbor", name: "Harbor Terminal", x: 9, y: 4, isHarbor: true },
  { id: "airport", name: "International Airport", x: 14, y: 2, isAirport: true },
  { id: "port", name: "Cargo Port", x: 12, y: 7, isPort: true, isIndustrial: true },
  { id: "industrial", name: "Industrial Park", x: 11, y: 10, isIndustrial: true },
  { id: "suburb-n", name: "Northern Suburbs", x: 4, y: 13 },
  { id: "suburb-s", name: "Southern Suburbs", x: 6, y: 3 },
  { id: "station", name: "Central Station", x: 5, y: 8.4 },
  { id: "warehouse", name: "Warehouse District", x: 10, y: 9 },
  { id: "old-town", name: "Old Town", x: 3, y: 9 },
];

export function hubById(id: string): Hub | undefined {
  return HUBS.find((h) => h.id === id || h.name.toLowerCase() === id.toLowerCase());
}

// distance in km between two hubs (Manhattan-ish to reflect road networks)
export function distanceKm(a: Hub, b: Hub): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  // diagonal-ish road distance
  return Math.round((Math.max(dx, dy) + 0.5 * Math.min(dx, dy)) * 10) / 10;
}

// Time helpers ----------------------------------------------------------------
export function parseTimeToMin(t?: string): number | null {
  if (!t) return null;
  const s = t.trim();
  // HH:mm or HH:mm:ss
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h >= 0 && h < 24 && min >= 0 && min < 60) return h * 60 + min;
  }
  // try ISO
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
  return null;
}

export function minToTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// --- Supply generation -------------------------------------------------------
// Build the market supply catalogue deterministically from the hub graph.
// Each entry is a candidate SEGMENT usable by the solver.
const RIDE_PROVIDERS = [
  { name: "Uber", costPerKm: 1.6, baseFare: 3, reliability: 0.86, comfort: 0.78, safety: 0.85 },
  { name: "Bolt", costPerKm: 1.45, baseFare: 2.5, reliability: 0.82, comfort: 0.74, safety: 0.82 },
  { name: "Local Taxi", costPerKm: 1.8, baseFare: 3.5, reliability: 0.78, comfort: 0.7, safety: 0.8 },
  { name: "Private Driver", costPerKm: 2.4, baseFare: 5, reliability: 0.93, comfort: 0.92, safety: 0.93 },
];

const BUS_LINES = [
  { name: "Bus 14", speedKmh: 22, costPerKm: 0.09, reliability: 0.74, comfort: 0.55, freqMin: 12 },
  { name: "Bus 22", speedKmh: 20, costPerKm: 0.08, reliability: 0.7, comfort: 0.5, freqMin: 15 },
  { name: "Express Bus", speedKmh: 30, costPerKm: 0.14, reliability: 0.8, comfort: 0.62, freqMin: 20 },
];

const TRAIN_LINES = [
  { name: "Metro Line 1", speedKmh: 38, costPerKm: 0.18, reliability: 0.92, comfort: 0.7, freqMin: 8 },
  { name: "Metro Line 4", speedKmh: 42, costPerKm: 0.2, reliability: 0.93, comfort: 0.72, freqMin: 10 },
  { name: "Regional Rail", speedKmh: 55, costPerKm: 0.26, reliability: 0.9, comfort: 0.8, freqMin: 30 },
];

// Latent supply / NPDs (§6) — pre-existing trips with spare capacity.
interface NPDTpl {
  id: string;
  from: string;
  to: string;
  depart: string; // HH:mm
  emptySeats: number;
  minComp: number; // minimum acceptable compensation
  reliability: number;
}
const NPDS: NPDTpl[] = [
  { id: "npd-77", from: "suburb-n", to: "downtown", depart: "07:30", emptySeats: 2, minComp: 4, reliability: 0.8 },
  { id: "npd-81", from: "suburb-n", to: "university", depart: "08:00", emptySeats: 3, minComp: 3, reliability: 0.78 },
  { id: "npd-88", from: "market", to: "industrial", depart: "17:15", emptySeats: 1, minComp: 6, reliability: 0.72 },
  { id: "npd-92", from: "downtown", to: "airport", depart: "06:45", emptySeats: 2, minComp: 9, reliability: 0.84 },
  { id: "npd-103", from: "university", to: "harbor", depart: "16:30", emptySeats: 2, minComp: 5, reliability: 0.76 },
  { id: "npd-115", from: "old-town", to: "warehouse", depart: "09:00", emptySeats: 4, minComp: 4, reliability: 0.81 },
];

function emissionFor(mode: Mode, km: number): number {
  // kg CO2e rough estimates
  const perKm: Record<Mode, number> = {
    walk: 0,
    bus: 0.06,
    train: 0.03,
    ferry: 0.12,
    rideshare: 0.18,
    carpool: 0.07, // shared, amortized
    freight: 0.22,
  };
  return Math.round(perKm[mode] * km * 100) / 100;
}

// Build ride-hailing segments for a hub pair.
function rideshareSegments(from: Hub, to: Hub, seed: number): SupplySegment[] {
  const km = distanceKm(from, to);
  const rand = rng(seed + km * 7);
  return RIDE_PROVIDERS.map((p, i) => {
    // dynamic demand factor 0.8..1.5
    const dyn = 0.85 + rand() * 0.7;
    const cost = Math.max(p.baseFare + p.costPerKm * km * dyn, p.baseFare + 1.5);
    const duration = (km / 32) * 60 * (1 + rand() * 0.15); // ~32 km/h urban avg
    return {
      id: `rs-${from.id}-${to.id}-${i}`,
      mode: "rideshare" as Mode,
      provider: p.name,
      from: from.id,
      to: to.id,
      baseCost: Math.round(cost * 100) / 100,
      baseDurationMin: Math.round(duration),
      distanceKm: km,
      reliability: p.reliability,
      emissionsKgCo2e: emissionFor("rideshare", km),
      comfort: p.comfort,
      safety: p.safety,
      walkingKm: 0,
      capacitySeats: 4,
      dynamicPriceFactor: Math.round(dyn * 100) / 100,
      dataFreshnessMin: 2 + Math.floor(rand() * 4),
    };
  });
}

function transitSegments(from: Hub, to: Hub, seed: number): SupplySegment[] {
  const km = distanceKm(from, to);
  const rand = rng(seed + km * 13 + 101);
  const out: SupplySegment[] = [];
  const all = [
    ...BUS_LINES.map((b) => ({ ...b, mode: "bus" as Mode, fare: Math.max(b.costPerKm * km, 0.6) })),
    ...TRAIN_LINES.map((t) => ({ ...t, mode: "train" as Mode, fare: Math.max(t.costPerKm * km, 1.0) })),
  ];
  // ferry only harbor/water adjacent
  if (from.isHarbor || to.isHarbor || (from.id === "harbor" || to.id === "harbor")) {
    all.push({
      name: "Harbor Ferry",
      speedKmh: 26,
      costPerKm: 0.1,
      reliability: 0.77,
      comfort: 0.66,
      freqMin: 30,
      mode: "ferries" as Mode,
      fare: Math.max(0.1 * km, 1.2),
    } as any);
  }
  for (const l of all) {
    const mode = (l as any).mode === "ferries" ? ("ferry" as Mode) : (l as any).mode;
    const duration = (km / (l as any).speedKmh) * 60 * (1 + rand() * 0.12);
    out.push({
      id: `${mode}-${from.id}-${to.id}-${(l as any).name.replace(/\s/g, "")}`,
      mode,
      provider: (l as any).name,
      from: from.id,
      to: to.id,
      baseCost: Math.round((l as any).fare * 100) / 100,
      baseDurationMin: Math.round(duration),
      distanceKm: km,
      reliability: (l as any).reliability,
      emissionsKgCo2e: emissionFor(mode, km),
      comfort: (l as any).comfort,
      safety: 0.86,
      walkingKm: 0,
      scheduledDeparture: undefined, // resolved against preferred departure at solve time
      capacitySeats: 50,
      dataFreshnessMin: 8 + Math.floor(rand() * 12),
    });
  }
  return out;
}

function walkSegment(from: Hub, to: Hub): SupplySegment {
  const km = distanceKm(from, to);
  return {
    id: `walk-${from.id}-${to.id}`,
    mode: "walk",
    provider: "Walk",
    from: from.id,
    to: to.id,
    baseCost: 0,
    baseDurationMin: Math.round((km / 5) * 60), // 5 km/h
    distanceKm: km,
    reliability: 0.98,
    emissionsKgCo2e: 0,
    comfort: 0.4,
    safety: 0.82,
    walkingKm: km,
    capacitySeats: 99,
    dataFreshnessMin: 0,
  };
}

function npdSegments(from: Hub, to: Hub): SupplySegment[] {
  const km = distanceKm(from, to);
  // Latent supply must genuinely serve origin->destination (exact hub match),
  // so a carpool segment always terminates at the requested destination.
  // (Partial-overlap matching would require composing an NPD + last-mile leg,
  //  which belongs in a richer matcher — kept honest here.)
  return NPDS.filter((n) => n.from === from.id && n.to === to.id).map((n) => {
    const comp = Math.max(n.minComp, 0.18 * km);
    return {
      id: `npd-${n.id}`,
      mode: "carpool" as Mode,
      provider: `Commuter ${n.id.toUpperCase()}`,
      from: n.from,
      to: n.to,
      baseCost: Math.round(comp * 100) / 100,
      baseDurationMin: Math.round((distanceKm(hubById(n.from)!, hubById(n.to)!) / 40) * 60),
      distanceKm: distanceKm(hubById(n.from)!, hubById(n.to)!),
      reliability: n.reliability,
      emissionsKgCo2e: emissionFor("carpool", km),
      comfort: 0.6,
      safety: 0.74,
      walkingKm: 0,
      scheduledDeparture: n.depart,
      capacitySeats: n.emptySeats,
      isLatentSupply: true,
      minAcceptableCompensation: n.minComp,
      dataFreshnessMin: 15,
    };
  });
}

// Public: enumerate candidate supply segments between two hubs.
export function supplyBetween(from: Hub, to: Hub, seed: number): SupplySegment[] {
  const out: SupplySegment[] = [];
  if (from.id === to.id) return out;
  out.push(...rideshareSegments(from, to, seed));
  out.push(...transitSegments(from, to, seed));
  out.push(...npdSegments(from, to));
  if (distanceKm(from, to) <= 2.5) out.push(walkSegment(from, to));
  return out;
}

// Place normalization ---------------------------------------------------------
// Tries to map free text to a known hub. Falls back to a synthetic hub so the
// solver still works for arbitrary inputs (§14: provider/data abstraction).
export function resolveHub(text: string): { hub: Hub; synthetic: boolean } {
  const t = text.trim().toLowerCase();
  const direct = HUBS.find(
    (h) => h.id.toLowerCase() === t || h.name.toLowerCase() === t,
  );
  if (direct) return { hub: direct, synthetic: false };
  const fuzzy = HUBS.find((h) => {
    const n = h.name.toLowerCase();
    return n.includes(t) || t.includes(n) || h.id.toLowerCase().includes(t);
  });
  if (fuzzy) return { hub: fuzzy, synthetic: false };
  // keyword hints
  if (/airport|fly|flight|air/.test(t)) return { hub: hubById("airport")!, synthetic: false };
  if (/port|cargo|container|freight|ship/.test(t)) return { hub: hubById("port")!, synthetic: false };
  if (/harbor|ferry|dock|water/.test(t)) return { hub: hubById("harbor")!, synthetic: false };
  if (/industr|factory|warehouse|depot/.test(t)) return { hub: hubById("industrial")!, synthetic: false };
  if (/school|university|college|campus|student/.test(t)) return { hub: hubById("university")!, synthetic: false };
  if (/station|train|rail|metro/.test(t)) return { hub: hubById("station")!, synthetic: false };
  if (/market|square|center|centre|downtown|city|town/.test(t)) return { hub: hubById("downtown")!, synthetic: false };
  if (/home|house|residential|suburb|home/.test(t)) return { hub: hubById("suburb-n")!, synthetic: false };
  // synthetic: deterministic pseudo-coordinate from string hash
  let hash = 0;
  for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) | 0;
  const rand = rng(Math.abs(hash) + 7);
  return {
    hub: { id: `syn-${Math.abs(hash) % 9999}`, name: text, x: Math.round(rand() * 14 * 10) / 10, y: Math.round(rand() * 12 * 10) / 10 },
    synthetic: true,
  };
}

export const AUTONOMY_LEVELS: { level: number; name: string; desc: string }[] = [
  { level: 0, name: "Recommend", desc: "ORYXX only recommends. You decide and act." },
  { level: 1, name: "Notify", desc: "ORYXX alerts you to opportunities." },
  { level: 2, name: "Negotiate", desc: "ORYXX negotiates on your behalf." },
  { level: 3, name: "Reserve", desc: "ORYXX reserves options (no payment)." },
  { level: 4, name: "Auto-book", desc: "ORYXX books automatically within your constraints." },
  { level: 5, name: "Optimize", desc: "ORYXX continuously re-optimizes your whole portfolio." },
];
