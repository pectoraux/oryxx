// ORYXX — Uncertainty model + sensitivity analysis engine.
//
// This is the central scientific instrument of this phase. Instead of treating
// willingness/capacity/execution as single fixed values, we model them as
// RANGES and run every candidate opportunity through an uncertainty grid.
//
// The headline metric becomes:
//   ROBUST OPPORTUNITIES PER 1,000 DEMANDS
// (opportunities that survive >80% of conservative scenarios)
//
// This directly attacks the previous phase's weakness: the fixture produced
// 710 opportunities/1000, but that was under ONE central assumption set. The
// question is: how many survive skeptical assumptions?

import type {
  DemandObservation,
  ObservedMovement,
  LatentSupply,
  TransportationOpportunity,
  GeographicNode,
  RealExperimentConfig,
  Confidence,
  OpportunityTier,
  DataSource,
} from "../types";
import type { Loc } from "../../../market/types";
import { haversineKm } from "../providers/interface";
import { rng } from "../../../market/generate";

// --- Uncertainty ranges (scenario parameters, NOT empirical) ---------------
// Each parameter is a RANGE, not a point. The grid sweeps these.
export interface UncertaintyGrid {
  willingness: number[];      // P(mover accepts)
  execution: number[];         // P(mover actually executes if matched)
  detourToleranceKm: number[]; // max detour
  capacity: number[];          // offerable seats
  compensationFloor: number[]; // min $ the mover will accept
}

export const CONSERVATIVE_GRID: UncertaintyGrid = {
  willingness: [0.10, 0.20, 0.30],
  execution: [0.40, 0.50, 0.60],
  detourToleranceKm: [0.5, 1.0, 2.0],
  capacity: [1],
  compensationFloor: [2.5, 4.0, 6.0],
};

export const CENTRAL_GRID: UncertaintyGrid = {
  willingness: [0.30, 0.40, 0.50],
  execution: [0.60, 0.70, 0.80],
  detourToleranceKm: [1.0, 2.0, 3.0],
  capacity: [1, 2],
  compensationFloor: [2.0, 2.5, 3.5],
};

export const FULL_GRID: UncertaintyGrid = {
  willingness: [0.10, 0.20, 0.30, 0.40, 0.50],
  execution: [0.40, 0.50, 0.60, 0.70, 0.80, 0.90],
  detourToleranceKm: [0.5, 1.0, 2.0, 3.0, 5.0],
  capacity: [1, 2, 3],
  compensationFloor: [2.0, 2.5, 4.0, 6.0],
};

export interface ScenarioAssumptions {
  willingness: number;
  execution: number;
  detourToleranceKm: number;
  capacity: number;
  compensationFloor: number;
  reliability: number;
}

// Enumerate all scenarios in the grid (cartesian product)
export function enumerateScenarios(grid: UncertaintyGrid): ScenarioAssumptions[] {
  const out: ScenarioAssumptions[] = [];
  for (const w of grid.willingness) {
    for (const e of grid.execution) {
      for (const d of grid.detourToleranceKm) {
        for (const c of grid.capacity) {
          for (const comp of grid.compensationFloor) {
            out.push({
              willingness: w,
              execution: e,
              detourToleranceKm: d,
              capacity: c,
              compensationFloor: comp,
              reliability: 0.6 + (e - 0.4) * 0.4, // reliability tracks execution
            });
          }
        }
      }
    }
  }
  return out;
}

// --- Survival rate: fraction of scenarios where a candidate survives -------
export interface SurvivalResult {
  candidateId: string;
  survivalRate: number;      // 0..1
  robust: boolean;          // >80%
  plausible: boolean;        // 50-80%
  fragile: boolean;         // 20-50%
  speculative: boolean;     // <20%
  survivedCount: number;
  totalScenarios: number;
  meanValueWhenSurvived: number;
  p10Value: number;
  p90Value: number;
  tier: OpportunityTier;
}

export type Robustness = "robust" | "plausible" | "fragile" | "speculative";

// For a candidate (demand, movement) pair, test survival across all scenarios
export function computeSurvival(
  demand: DemandObservation,
  movement: ObservedMovement,
  baselineCost: number,
  baselineTimeMin: number,
  scenarios: ScenarioAssumptions[],
  nodes: GeographicNode[],
): SurvivalResult | null {
  let survived = 0;
  const values: number[] = [];

  for (const s of scenarios) {
    // spatial feasibility: is the demand on the movement's route within detour?
    const pickupDetour = detourKm(demand.origin, movement.origin, nodes);
    const dropoffDetour = detourKm(demand.destination, movement.destination, nodes);
    const detour = (pickupDetour + dropoffDetour) / 2;
    if (detour > s.detourToleranceKm) continue;

    // temporal: movement departure within demand window
    if (movement.departureSec < demand.windowStartSec || movement.departureSec > demand.windowEndSec) continue;

    // capacity
    if (s.capacity < demand.partySize) continue;

    // economic: opportunity must be cheaper than baseline AND cover compensation floor
    const opportunityCost = Math.max(s.compensationFloor, baselineCost * 0.6);
    if (opportunityCost >= baselineCost) continue;
    if (opportunityCost > demand.budget) continue;

    // willingness filter: only count if mover would accept (probabilistic)
    // we treat willingness as the probability the candidate EXISTS at all
    // → weight survival by willingness
    const supplierCost = Math.round((haversineKm(locToLatLon(movement.origin, nodes), locToLatLon(movement.destination, nodes)) + detour) * 0.12 * 100) / 100;
    const socialSurplus = (demand.value - opportunityCost) + (opportunityCost - supplierCost);
    if (socialSurplus <= 0) continue;

    survived++;
    // weight the value by execution probability (expected value)
    const expectedValue = socialSurplus * s.execution * s.willingness;
    values.push(expectedValue);
  }

  if (survived === 0) return null;

  const survivalRate = survived / scenarios.length;
  const sorted = [...values].sort((a, b) => a - b);
  const meanValue = values.reduce((a, b) => a + b, 0) / values.length;
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;

  const robust = survivalRate > 0.8;
  const plausible = survivalRate > 0.5 && survivalRate <= 0.8;
  const fragile = survivalRate >= 0.2 && survivalRate <= 0.5;
  const speculative = survivalRate < 0.2;

  // tier: 3 = economically attractive under conservative assumptions + robust
  let tier: OpportunityTier = 1;
  if (survivalRate > 0.5 && meanValue > 3) tier = 2;
  if (robust && meanValue > 5) tier = 3;

  return {
    candidateId: `${demand.id}-${movement.id}`,
    survivalRate: Math.round(survivalRate * 1000) / 1000,
    robust, plausible, fragile, speculative,
    survivedCount: survived,
    totalScenarios: scenarios.length,
    meanValueWhenSurvived: Math.round(meanValue * 100) / 100,
    p10Value: Math.round(p10 * 100) / 100,
    p90Value: Math.round(p90 * 100) / 100,
    tier,
  };
}

// --- Spatial/temporal indexing for performance (prompt §23) ----------------
// Index movements by spatial cell + time bucket so we don't do O(N×M).
export interface MovementIndex {
  cellSize: number; // km
  byCell: Map<string, { movement: ObservedMovement; cellKey: string }[]>;
  byHour: Map<number, ObservedMovement[]>;
}

export function buildMovementIndex(movements: ObservedMovement[], cellSize = 1.0): MovementIndex {
  const byCell = new Map<string, { movement: ObservedMovement; cellKey: string }[]>();
  const byHour = new Map<number, ObservedMovement[]>();
  for (const m of movements) {
    const cellKey = cellKeyOf(m.origin, cellSize);
    const arr = byCell.get(cellKey) ?? [];
    arr.push({ movement: m, cellKey });
    byCell.set(cellKey, arr);
    const hour = Math.floor(m.departureSec / 3600);
    const hArr = byHour.get(hour) ?? [];
    hArr.push(m);
    byHour.set(hour, hArr);
  }
  return { cellSize, byCell, byHour };
}

export function cellKeyOf(loc: Loc, cellSize: number): string {
  return `${Math.floor(loc.x / cellSize)},${Math.floor(loc.y / cellSize)}`;
}

// Find candidate movements near a demand (spatial + temporal window)
export function findCandidateMovements(
  demand: DemandObservation,
  index: MovementIndex,
  maxDetourKm: number,
  horizonSec: number = 0,
): ObservedMovement[] {
  const candidates: ObservedMovement[] = [];
  const seen = new Set<string>();
  const demandHour = Math.floor(demand.windowStartSec / 3600);
  // check this hour + adjacent hours
  for (let h = demandHour - 1; h <= demandHour + 1; h++) {
    const hourMovements = index.byHour.get(h) ?? [];
    for (const m of hourMovements) {
      if (seen.has(m.id)) continue;
      // expanded temporal window
      const startW = demand.windowStartSec - horizonSec;
      const endW = demand.windowEndSec + horizonSec;
      if (m.departureSec < startW || m.departureSec > endW) continue;
      // quick spatial filter: within maxDetourKm of origin cell
      const dCell = cellKeyOf(demand.origin, index.cellSize);
      const mCell = cellKeyOf(m.origin, index.cellSize);
      const [dx, dy] = dCell.split(",").map(Number);
      const [mx, my] = mCell.split(",").map(Number);
      if (Math.abs(dx - mx) > Math.ceil(maxDetourKm / index.cellSize) + 1) continue;
      if (Math.abs(dy - my) > Math.ceil(maxDetourKm / index.cellSize) + 1) continue;
      candidates.push(m);
      seen.add(m.id);
    }
  }
  return candidates;
}

// --- Density-fit analysis (prompt §14) --------------------------------------
export interface DensityFit {
  model: "linear" | "logarithmic" | "power" | "quadratic";
  formula: string;
  r2: number;
  coef: number;
}

export function fitDensityModels(points: { density: number; opportunities: number }[]): DensityFit[] {
  const xs = points.map((p) => p.density);
  const ys = points.map((p) => p.opportunities);
  const fits: DensityFit[] = [];

  // linear: y = a*x + b
  const lin = linearFit(xs, ys);
  fits.push({ model: "linear", formula: `y = ${lin.a.toFixed(2)}x + ${lin.b.toFixed(2)}`, r2: lin.r2, coef: lin.a });

  // logarithmic: y = a*ln(x) + b
  const logFit = linearFit(xs.map(Math.log), ys);
  fits.push({ model: "logarithmic", formula: `y = ${logFit.a.toFixed(2)}·ln(x) + ${logFit.b.toFixed(2)}`, r2: logFit.r2, coef: logFit.a });

  // power: y = a * x^b  (fit via log-log linear)
  if (xs.every((x) => x > 0) && ys.every((y) => y > 0)) {
    const pw = linearFit(xs.map(Math.log), ys.map(Math.log));
    fits.push({ model: "power", formula: `y = ${Math.exp(pw.b).toFixed(2)}·x^${pw.a.toFixed(3)}`, r2: pw.r2, coef: pw.a });
  }

  // quadratic: y = a*x² + b*x + c
  const quad = quadraticFit(xs, ys);
  fits.push({ model: "quadratic", formula: `y = ${quad.a.toFixed(3)}x² + ${quad.b.toFixed(2)}x + ${quad.c.toFixed(2)}`, r2: quad.r2, coef: quad.a });

  return fits;
}

function linearFit(xs: number[], ys: number[]): { a: number; b: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { a: 0, b: 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const a = den === 0 ? 0 : num / den;
  const b = my - a * mx;
  // R²
  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = a * xs[i] + b;
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { a, b, r2 };
}

function quadraticFit(xs: number[], ys: number[]): { a: number; b: number; c: number; r2: number } {
  const n = xs.length;
  if (n < 3) return { a: 0, b: 0, c: 0, r2: 0 };
  let s4 = 0, s3 = 0, s2 = 0, s1 = 0, s0 = n;
  let sy2 = 0, sy1 = 0, sy0 = 0;
  for (let i = 0; i < n; i++) {
    s4 += xs[i] ** 4; s3 += xs[i] ** 3; s2 += xs[i] ** 2; s1 += xs[i];
    sy2 += xs[i] ** 2 * ys[i]; sy1 += xs[i] * ys[i]; sy0 += ys[i];
  }
  const A = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const B = [sy2, sy1, sy0];
  const det = det3(A);
  if (Math.abs(det) < 1e-12) return { a: 0, b: 0, c: 0, r2: 0 };
  const a = det3([B, A[1], A[2]]) / det;
  const b = det3([A[0], B, A[2]]) / det;
  const c = det3([A[0], A[1], B]) / det;
  const yMean = sy0 / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = a * xs[i] ** 2 + b * xs[i] + c;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { a, b, c, r2 };
}

function det3(m: number[][]): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
       - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
       + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

// --- Robustness classification ----------------------------------------------
export function robustnessOf(survivalRate: number): Robustness {
  if (survivalRate > 0.8) return "robust";
  if (survivalRate > 0.5) return "plausible";
  if (survivalRate >= 0.2) return "fragile";
  return "speculative";
}

// --- Helpers (mirrors from opportunity.ts, kept local to avoid circular deps)
function detourKm(loc: Loc, ref: Loc, nodes: GeographicNode[]): number {
  const a = locToLatLon(loc, nodes);
  const b = locToLatLon(ref, nodes);
  return haversineKm(a, b);
}

function locToLatLon(loc: Loc, nodes: GeographicNode[]): { lat: number; lon: number } {
  // reverse projectToKm (approximate)
  const centerLat = 5.60, centerLon = -0.20;
  const lat = centerLat + loc.y / 111;
  const lon = centerLon + loc.x / (111 * Math.cos((centerLat * Math.PI) / 180));
  return { lat, lon };
}
