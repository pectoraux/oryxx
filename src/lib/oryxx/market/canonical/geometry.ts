// ORYXX — Canonical geometry (extracted from generate.ts so the canonical
// layer has no dependency on the population generator).
import type { Loc } from "../types";

export function dist(a: Loc, b: Loc): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.round((Math.max(dx, dy) + 0.5 * Math.min(dx, dy)) * 100) / 100;
}

// Perpendicular distance from point P to polyline segment A->B.
export function detourFromSegment(p: Loc, a: Loc, b: Loc): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx, cy = a.y + t * aby;
  return dist({ x: p.x, y: p.y }, { x: cx, y: cy });
}

// Does the supply's planned route pass near both pickup and dropoff, in order?
export function routeServes(
  route: Loc[],
  pickup: Loc,
  dropoff: Loc,
  toleranceKm: number,
): { feasible: boolean; detourKm: number } {
  if (route.length < 2) {
    return { feasible: false, detourKm: 0 };
  }
  let bestPickup = Infinity, bestDropoff = Infinity, pi = 0, di = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const dP = detourFromSegment(pickup, route[i], route[i + 1]);
    const dD = detourFromSegment(dropoff, route[i], route[i + 1]);
    if (dP < bestPickup) { bestPickup = dP; pi = i; }
    if (dD < bestDropoff) { bestDropoff = dD; di = i; }
  }
  const feasible = bestPickup <= toleranceKm && bestDropoff <= toleranceKm && pi <= di;
  return { feasible, detourKm: Math.round((bestPickup + bestDropoff) * 100) / 100 };
}

export function travelTimeMin(a: Loc, b: Loc, speedKmh: number): number {
  return Math.max(2, Math.round((dist(a, b) / speedKmh) * 60));
}
