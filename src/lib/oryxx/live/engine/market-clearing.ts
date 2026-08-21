// ORYXX — Live Marketplace Clearing Engine
//
// Given:
//   - demands (TransportationDemand[])
//   - supplies (TransportationSupply[])
//   - opportunities (TransportationOpportunity[]) discovered by the
//     OpportunityEngine
//
// Produce a welfare-maximizing greedy matching:
//   - each demand can be matched at most once
//   - each supply can serve multiple demands up to its availableCapacity
//   - matches are accepted in descending order of social welfare
//     (value - cost), respecting capacity constraints
//   - clears with full audit metadata (solverVersion, solverMode,
//     optimizationTimestamp)
//
// The greedy choice is provably optimal under the unit-demand, separable-cost
// setting when each demand is matched at most once. It is also fast (O(n log n))
// and deterministic — both essential for live marketplace latency.
//
// Money is always integer minor units (cents). No floating-point money.

import type {
  TransportationDemand,
  TransportationOpportunity,
  TransportationSupply,
} from "../types";
import { haversineKm } from "./opportunity-engine";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

/**
 * A single cleared match between a demand and a supply, with full money
 * breakdown. Money is integer minor units.
 */
export interface ClearedMatch {
  opportunityId: string;
  demandId: string;
  supplyId: string;
  /** Total user price (supplier compensation + platform fee). Minor units. */
  price: number;
  /** Amount paid to the supplier. Minor units. */
  supplierCompensation: number;
  /** Amount retained by the platform. Minor units. */
  platformFee: number;
  /** Social welfare (demand.value - estimated provider cost). Minor units. */
  welfare: number;
  /** Capacity consumed on the supply by this match (e.g. seats). */
  capacityUsed: number;
  /** Rank in the greedy order (0 = highest welfare). For audit. */
  rank: number;
}

/**
 * Result of a market clearing pass. Includes audit metadata required by
 * downstream verification (solver version, mode, timestamp) and a summary
 * of unmatched demands for retry / fallback to ordinary routing.
 */
export interface ClearResult {
  matches: ClearedMatch[];
  /** Demand IDs that no opportunity could serve under capacity constraints. */
  unmatchedDemandIds: string[];
  solverVersion: string;
  solverMode: "greedy-welfare-maximizing";
  optimizationTimestamp: string;
  stats: {
    totalDemands: number;
    totalSupplies: number;
    totalOpportunities: number;
    matchedDemands: number;
    totalWelfare: number;
    totalPlatformFee: number;
    totalSupplierCompensation: number;
    totalUserPrice: number;
    capacityUsedBySupply: Record<string, number>;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/** Bumped on any change to the algorithm — for audit trail. */
export const SOLVER_VERSION = "oryxx-clearing-v1.0.0";

export const SOLVER_MODE = "greedy-welfare-maximizing" as const;

// Speed model (must match opportunity-engine.ts so cost estimates align).
const MODE_SPEED_KMH: Record<TransportationSupply["mode"], number> = {
  rideshare: 35,
  carpool: 35,
  taxi: 35,
  fhv: 32,
  truck: 30,
  transit: 25,
  walking: 5,
  micromobility: 15,
};

// ═══════════════════════════════════════════════════════════════════════
// COST + WELFARE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Recompute the estimated provider operating cost for this opportunity using
 * the supply's actual cost model. We recompute (rather than trusting the
 * opportunity's stored numbers) so that the clearing decision uses the same
 * canonical welfare definition as evaluate.ts: welfare = value - cost, where
 * cost is independent of price (a pure transfer).
 *
 * All money is integer minor units.
 */
function estimateProviderCost(
  opportunity: TransportationOpportunity,
  supply: TransportationSupply,
): number {
  const km = Math.max(opportunity.route.distanceKm, 0);
  const hours = Math.max(opportunity.route.estimatedTimeMin, 0) / 60;
  const cm = supply.costModel;
  return Math.round(cm.fixedCost + km * cm.costPerKm + hours * cm.costPerHour);
}

/**
 * Social welfare of a (demand, supply) match: demand.value - provider cost.
 *
 * This is the canonical ORYXX welfare definition (see market/canonical/
 * evaluate.ts). Price is a TRANSFER between user and supplier; it does not
 * create social value. Welfare is therefore invariant to the negotiated price.
 */
function welfare(
  demand: TransportationDemand,
  supply: TransportationSupply,
  opportunity: TransportationOpportunity,
): number {
  const cost = estimateProviderCost(opportunity, supply);
  return demand.value - cost;
}

// ═══════════════════════════════════════════════════════════════════════
// GREEDY MATCHING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Clear the market: greedily match demands to supplies maximizing welfare,
 * respecting capacity constraints (a supply can serve multiple demands if its
 * available capacity allows).
 *
 * Algorithm:
 *   1. Build lookup tables for demands and supplies by ID.
 *   2. Compute welfare for each opportunity.
 *   3. Sort opportunities by welfare descending (tiebreaker: executionProbability).
 *   4. Walk the sorted list. For each opportunity:
 *        - skip if its demand is already matched
 *        - skip if its supply has insufficient remaining capacity
 *        - skip if its supply status is not AVAILABLE/COMMITTED
 *        - otherwise: emit a ClearedMatch, mark demand matched, decrement supply
 *   5. Return matches + unmatched demand IDs + audit metadata.
 *
 * @returns ClearResult with matches, unmatched demand IDs, and audit metadata.
 */
export function clearMarket(
  demands: TransportationDemand[],
  supplies: TransportationSupply[],
  opportunities: TransportationOpportunity[],
): ClearResult {
  const demandById = new Map<string, TransportationDemand>();
  for (const d of demands) demandById.set(d.id, d);

  const supplyById = new Map<string, TransportationSupply>();
  // Track remaining capacity per supply (mutable copy).
  const remainingCapacity = new Map<string, number>();
  const capacityUsedBySupply: Record<string, number> = {};
  for (const s of supplies) {
    supplyById.set(s.id, s);
    remainingCapacity.set(s.id, s.availableCapacity);
    capacityUsedBySupply[s.id] = 0;
  }

  // Score each opportunity with its recomputed welfare.
  const scored = opportunities
    .map((opp) => {
      const demand = demandById.get(opp.demandId);
      const supply = supplyById.get(opp.supplyId);
      // If we can't resolve either side, the opportunity is stale / orphaned.
      const w = demand && supply ? welfare(demand, supply, opp) : -Infinity;
      return { opp, demand, supply, w };
    })
    .filter((x) => x.demand && x.supply);

  // Sort by welfare descending; tiebreak by executionProbability then by
  // detour ascending (less detour = more robust match).
  scored.sort((a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    if (b.opp.executionProbability !== a.opp.executionProbability) {
      return b.opp.executionProbability - a.opp.executionProbability;
    }
    return a.opp.detourKm - b.opp.detourKm;
  });

  const matchedDemandIds = new Set<string>();
  const matches: ClearedMatch[] = [];
  let totalWelfare = 0;
  let totalPlatformFee = 0;
  let totalSupplierCompensation = 0;
  let totalUserPrice = 0;

  for (const { opp, demand, supply, w } of scored) {
    if (!demand || !supply) continue;

    // Skip zero-or-negative-welfare matches: they destroy value.
    if (w <= 0) continue;

    if (matchedDemandIds.has(demand.id)) continue;

    const remaining = remainingCapacity.get(supply.id) ?? 0;
    if (remaining < demand.partySize) continue;

    // Supply must still be in a serviceable state.
    if (
      supply.status !== "AVAILABLE" &&
      supply.status !== "COMMITTED" &&
      supply.status !== "RESERVED"
    ) {
      continue;
    }

    // Accept the match.
    const used = demand.partySize;
    remainingCapacity.set(supply.id, remaining - used);
    capacityUsedBySupply[supply.id] += used;
    matchedDemandIds.add(demand.id);

    matches.push({
      opportunityId: opp.id,
      demandId: demand.id,
      supplyId: supply.id,
      price: opp.price,
      supplierCompensation: opp.supplierCompensation,
      platformFee: opp.platformFee,
      welfare: w,
      capacityUsed: used,
      rank: matches.length,
    });

    totalWelfare += w;
    totalPlatformFee += opp.platformFee;
    totalSupplierCompensation += opp.supplierCompensation;
    totalUserPrice += opp.price;
  }

  const unmatchedDemandIds = demands
    .filter((d) => !matchedDemandIds.has(d.id))
    .map((d) => d.id);

  return {
    matches,
    unmatchedDemandIds,
    solverVersion: SOLVER_VERSION,
    solverMode: SOLVER_MODE,
    optimizationTimestamp: new Date().toISOString(),
    stats: {
      totalDemands: demands.length,
      totalSupplies: supplies.length,
      totalOpportunities: opportunities.length,
      matchedDemands: matches.length,
      totalWelfare,
      totalPlatformFee,
      totalSupplierCompensation,
      totalUserPrice,
      capacityUsedBySupply,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS (for downstream audit / replay)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Group cleared matches by supply ID. Useful for dispatch: each supply gets
 * a list of demands to serve in sequence.
 */
export function groupMatchesBySupply(
  matches: ClearedMatch[],
): Map<string, ClearedMatch[]> {
  const grouped = new Map<string, ClearedMatch[]>();
  for (const m of matches) {
    const list = grouped.get(m.supplyId) ?? [];
    list.push(m);
    grouped.set(m.supplyId, list);
  }
  return grouped;
}

/**
 * Sanity check: total capacity used per supply must not exceed its initial
 * available capacity. Used by the audit / verification layer.
 */
export function validateCapacityConstraints(
  result: ClearResult,
  supplies: TransportationSupply[],
): { ok: boolean; violations: Array<{ supplyId: string; used: number; available: number }> } {
  const violations: Array<{ supplyId: string; used: number; available: number }> = [];
  for (const s of supplies) {
    const used = result.stats.capacityUsedBySupply[s.id] ?? 0;
    if (used > s.availableCapacity) {
      violations.push({ supplyId: s.id, used, available: s.availableCapacity });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Re-export haversine for downstream modules that need geometric reasoning.
export { haversineKm };
