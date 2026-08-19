// ORYXX — geometry helpers + deterministic population generators for the
// transportation market. Seeded so experiments are reproducible.

import type {
  DemandRequest,
  DemandKind,
  Loc,
  SupplyOffer,
  SupplyKind,
} from "./types";

// --- geometry ---------------------------------------------------------------
export function dist(a: Loc, b: Loc): number {
  // road-network-ish (manhattan with diagonal slack), in km
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.round((Math.max(dx, dy) + 0.5 * Math.min(dx, dy)) * 100) / 100;
}

// Distance from point P to the polyline segment A->B (perpendicular detour).
export function detourFromSegment(p: Loc, a: Loc, b: Loc): number {
  const ax = a.x, ay = a.y, bx = b.x, by = b.y, px = p.x, py = p.y;
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx, cy = ay + t * aby;
  return dist({ x: px, y: py }, { x: cx, y: cy });
}

// A supply route passes near a demand origin/destination if both are within
// detourTolerance of some segment of the supply's planned route.
export function routeServes(
  route: Loc[],
  pickup: Loc,
  dropoff: Loc,
  toleranceKm: number,
): { feasible: boolean; detourKm: number; pickupIdx: number; dropoffIdx: number } {
  if (route.length < 2) {
    // direct A->B supply: check if it's "along the way" loosely via detour
    const d1 = detourFromSegment(pickup, route[0], route[route.length - 1]);
    const d2 = detourFromSegment(dropoff, route[0], route[route.length - 1]);
    const detour = d1 + d2;
    return { feasible: detour <= toleranceKm, detourKm: detour, pickupIdx: 0, dropoffIdx: 1 };
  }
  let bestPickup = Infinity, bestDropoff = Infinity, pi = 0, di = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const dP = detourFromSegment(pickup, route[i], route[i + 1]);
    const dD = detourFromSegment(dropoff, route[i], route[i + 1]);
    if (dP < bestPickup) { bestPickup = dP; pi = i; }
    if (dD < bestDropoff) { bestDropoff = dD; di = i; }
  }
  // pickup must come before (or at) dropoff along the route
  const feasible = bestPickup <= toleranceKm && bestDropoff <= toleranceKm && pi <= di;
  return { feasible, detourKm: bestPickup + bestDropoff, pickupIdx: pi, dropoffIdx: di };
}

// --- PRNG (mulberry32) ------------------------------------------------------
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

// lognormal-ish sample for budgets/values
function lognormal(r: () => number, median: number, spread: number): number {
  // Box-Muller
  const u1 = Math.max(1e-9, r());
  const u2 = r();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(Math.max(1, median * Math.exp(z * spread)) * 100) / 100;
}

// --- named places (a small geography so the UI reads naturally) -------------
const PLACES = [
  "Market Sq", "Downtown", "University", "Harbor", "Airport",
  "Cargo Port", "Industrial Park", "North Suburb", "South Suburb",
  "Central Station", "Warehouse", "Old Town", "Riverside", "Tech Park",
  "Stadium", "Hospital", "Mall", "Convention Center",
];

export interface Place extends Loc {
  name: string;
}

export function places(regionKm: number): Place[] {
  const r = rng(regionKm * 977);
  return PLACES.map((name, i) => ({
    name,
    x: Math.round(r() * regionKm * 100) / 100,
    y: Math.round(r() * regionKm * 100) / 100,
  }));
}

function randomPlace(r: () => number, ps: Place[]): Place {
  return ps[Math.floor(r() * ps.length)];
}

// Two distinct places
function twoPlaces(r: () => number, ps: Place[]): [Place, Place] {
  const a = randomPlace(r, ps);
  let b = randomPlace(r, ps);
  let guard = 0;
  while (b.name === a.name && guard++ < 5) b = randomPlace(r, ps);
  return [a, b];
}

// --- demand generation ------------------------------------------------------
const DEMAND_KIND_WEIGHTS: { kind: DemandKind; w: number; party: [number, number]; weight?: [number, number] }[] = [
  { kind: "person", w: 0.45, party: [1, 1] },
  { kind: "people", w: 0.2, party: [2, 4] },
  { kind: "parcel", w: 0.2, party: [1, 1], weight: [1, 20] },
  { kind: "pallet", w: 0.1, party: [1, 2], weight: [200, 800] },
  { kind: "container", w: 0.05, party: [1, 1], weight: [2000, 8000] },
];

function weightedKind(r: () => number): typeof DEMAND_KIND_WEIGHTS[number] {
  const total = DEMAND_KIND_WEIGHTS.reduce((a, k) => a + k.w, 0);
  let x = r() * total;
  for (const k of DEMAND_KIND_WEIGHTS) {
    if (x < k.w) return k;
    x -= k.w;
  }
  return DEMAND_KIND_WEIGHTS[0];
}

export function generateDemands(config: {
  seed: number;
  n: number;
  regionKm: number;
  places: Place[];
}): DemandRequest[] {
  const r = rng(config.seed * 31 + 17);
  const out: DemandRequest[] = [];
  for (let i = 0; i < config.n; i++) {
    const tpl = weightedKind(r);
    const [o, d] = twoPlaces(r, config.places);
    const distance = dist(o, d);
    // time window: cluster around commute peaks with spread
    const peak = pick(r, [7 * 60 + 30, 8 * 60, 8 * 60 + 30, 17 * 60, 18 * 60, 9 * 60, 12 * 60 + 30]);
    const spread = 20 + Math.floor(r() * 60);
    const start = peak - Math.floor(r() * spread);
    const end = start + 15 + Math.floor(r() * 45);
    const partySize = tpl.party[0] + Math.floor(r() * (tpl.party[1] - tpl.party[0] + 1));
    // value ~ a function of distance + kind; budget < value (user keeps surplus).
    // Calibrated so ordinary rideshare (the baseline) is affordable for ~50-60%
    // of person trips — realistic, since people do use Uber today. ORYXX then
    // serves the rest via latent supply / transit / trucks.
    const ordinaryPerKm = tpl.kind === "container" ? 0.4 : tpl.kind === "pallet" ? 0.6 : tpl.kind === "parcel" ? 0.9 : 1.6;
    const ordinaryCost = 3 + ordinaryPerKm * distance; // what ordinary routing charges
    const value = Math.max(ordinaryCost * 0.8, lognormal(r, ordinaryCost * 1.6, 0.4));
    const budget = Math.round(value * (0.6 + r() * 0.35) * 100) / 100; // budget is 60-95% of value
    out.push({
      id: `D${i + 1}`,
      kind: tpl.kind,
      origin: { x: o.x, y: o.y },
      destination: { x: d.x, y: d.y },
      window: { start: Math.max(5 * 60, start), end: Math.min(23 * 60, end) },
      latestArrival: undefined,
      partySize,
      weightKg: tpl.weight ? Math.round(tpl.weight[0] + r() * (tpl.weight[1] - tpl.weight[0])) : undefined,
      budget,
      value,
      createdAt: 0,
      originName: o.name,
      destName: d.name,
    });
  }
  return out;
}

// --- supply generation ------------------------------------------------------
export function generateSupplies(config: {
  seed: number;
  numDrivers: number;
  numNPDs: number;
  numTrucks: number;
  numTransitLines: number;
  regionKm: number;
  places: Place[];
}): SupplyOffer[] {
  const r = rng(config.seed * 53 + 23);
  const out: SupplyOffer[] = [];
  let n = 0;

  // committed rideshare drivers — a fixed active fleet
  for (let i = 0; i < config.numDrivers; i++) {
    const [o, d] = twoPlaces(r, config.places);
    const peak = pick(r, [7 * 60 + 30, 8 * 60, 8 * 60 + 30, 17 * 60, 18 * 60]);
    const departure = peak + Math.floor((r() - 0.5) * 30);
    out.push({
      id: `DRV${++n}`,
      kind: "rideshare",
      origin: { x: o.x, y: o.y },
      destination: { x: d.x, y: d.y },
      originName: o.name,
      destName: d.name,
      departure,
      capacitySeats: 4,
      availableCapacity: 4,
      minCompensation: Math.max(3, dist(o, d) * 0.6),
      detourToleranceKm: 1.5,
      executionProbability: 0.92,
      reliability: 0.86,
      costPerKm: 0.35,
      isCommitted: true,
      route: [{ x: o.x, y: o.y }, { x: d.x, y: d.y }],
    });
  }

  // NPDs — latent supply. Mix of committed (driving anyway) and potential
  // (only drive if matched — avoids a deadhead trip). This is the reviewer's
  // point #5 distinction made concrete.
  for (let i = 0; i < config.numNPDs; i++) {
    const [o, d] = twoPlaces(r, config.places);
    const peak = pick(r, [7 * 60 + 30, 8 * 60, 8 * 60 + 30, 17 * 60, 18 * 60]);
    const departure = peak + Math.floor((r() - 0.5) * 20);
    const committed = r() < 0.45;
    out.push({
      id: `NPD${++n}`,
      kind: "carpool-npd",
      origin: { x: o.x, y: o.y },
      destination: { x: d.x, y: d.y },
      originName: o.name,
      destName: d.name,
      departure,
      capacitySeats: 1 + Math.floor(r() * 3),
      availableCapacity: 0, // set below
      minCompensation: Math.max(2, dist(o, d) * 0.18),
      detourToleranceKm: 2 + r() * 3,
      executionProbability: 0.7 + r() * 0.2,
      reliability: 0.74 + r() * 0.1,
      costPerKm: 0.12,
      isCommitted: committed,
      route: [{ x: o.x, y: o.y }, { x: d.x, y: d.y }],
    });
  }

  // trucks — freight, often with empty return legs (a classic waste source)
  for (let i = 0; i < config.numTrucks; i++) {
    const [o, d] = twoPlaces(r, config.places);
    const departure = 6 * 60 + Math.floor(r() * 12 * 60);
    const committed = r() < 0.6;
    out.push({
      id: `TRK${++n}`,
      kind: "truck",
      origin: { x: o.x, y: o.y },
      destination: { x: d.x, y: d.y },
      originName: o.name,
      destName: d.name,
      departure,
      capacitySeats: 1 + Math.floor(r() * 3), // pallet/container "seats"
      availableCapacity: 0,
      minCompensation: Math.max(8, dist(o, d) * 0.4),
      detourToleranceKm: 4 + r() * 4,
      executionProbability: 0.78 + r() * 0.15,
      reliability: 0.8,
      costPerKm: 0.55,
      isCommitted: committed,
      route: [{ x: o.x, y: o.y }, { x: d.x, y: d.y }],
    });
  }

  // transit lines — scheduled, recurring, high capacity, fixed routes
  for (let i = 0; i < config.numTransitLines; i++) {
    const [o, d] = twoPlaces(r, config.places);
    const departure = 6 * 60;
    const cap = 40 + Math.floor(r() * 40);
    out.push({
      id: `TRN${++n}`,
      kind: "transit",
      origin: { x: o.x, y: o.y },
      destination: { x: d.x, y: d.y },
      originName: o.name,
      destName: d.name,
      departure,
      capacitySeats: cap,
      availableCapacity: cap,
      minCompensation: 1.5,
      detourToleranceKm: 0.8,
      executionProbability: 0.95,
      reliability: 0.9,
      costPerKm: 0.06,
      isCommitted: true,
      route: [{ x: o.x, y: o.y }, { x: d.x, y: d.y }],
      scheduleFreqMin: 10 + Math.floor(r() * 20),
    });
  }

  // initialize availableCapacity = capacitySeats
  for (const s of out) s.availableCapacity = s.capacitySeats;
  return out;
}
