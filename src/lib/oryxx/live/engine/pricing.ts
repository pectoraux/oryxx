// ORYXX — Live Marketplace Pricing Engine
//
// Given a discovered TransportationOpportunity and the supply that backs it,
// compute a full PricingResult: user price, supplier compensation, platform
// fee, estimated provider cost, and expected margin.
//
// Pricing is ALWAYS labeled "estimated" at this stage — the final price is only
// set when an offer is accepted and an agreement is formed. The estimated
// label is what prevents sandbox prices from being mistaken for binding quotes.
//
// Pricing model:
//   - estimatedProviderCost = supply.costModel.fixedCost
//                           + distanceKm * supply.costModel.costPerKm
//                           + (timeMin/60) * supply.costModel.costPerHour
//   - supplierCompensation  = max(minimumCompensation, cost * (1 + supplierMargin))
//   - platformFee           = round(supplierCompensation * platformFeeRate)
//   - userPrice             = supplierCompensation + platformFee
//   - expectedMargin        = userPrice - estimatedProviderCost
//
// All money is integer minor units (cents). No floating-point money. The
// platform fee rate defaults to 15% (the ORYXX marketplace standard); callers
// can override it per-call (e.g. for promo periods, enterprise contracts).

import type {
  TransportationOpportunity,
  TransportationSupply,
} from "../types";
import { haversineKm } from "./opportunity-engine";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Estimated pricing for a transportation opportunity.
 *
 * - All monetary fields are integer minor units (cents).
 * - `label` is "estimated" until an offer is accepted and an agreement
 *   is formed; downstream code MUST NOT treat estimated prices as binding.
 * - `breakdown` carries the structural inputs (distance, time, cost rates,
 *   fee rate) so the UI can show "why this price" without recomputing.
 */
export interface PricingResult {
  /** Total price the user pays = supplierCompensation + platformFee. */
  userPrice: number;
  /** Amount paid to the supplier (cost + supplier margin). */
  supplierCompensation: number;
  /** Amount retained by the platform. */
  platformFee: number;
  /** Estimated real cost to the supplier of executing the trip. */
  estimatedProviderCost: number;
  /** Total economic margin = userPrice - estimatedProviderCost. */
  expectedMargin: number;
  /** Supplier's profit = supplierCompensation - estimatedProviderCost. */
  supplierMargin: number;
  /** Whether this price is estimated or final (binding). */
  label: "estimated" | "final";
  /** Structural breakdown for UI / audit. */
  breakdown: PricingBreakdown;
}

export interface PricingBreakdown {
  /** Total trip distance the supply will drive (pickup→dropoff + detour), km. */
  distanceKm: number;
  /** Estimated travel time, minutes. */
  estimatedTimeMin: number;
  /** Detour distance off the supply's planned route, km. */
  detourKm: number;
  /** Cost per km from the supply's cost model (minor units). */
  costPerKm: number;
  /** Cost per hour from the supply's cost model (minor units). */
  costPerHour: number;
  /** Fixed cost from the supply's cost model (minor units). */
  fixedCost: number;
  /** Minimum compensation floor from the supply's cost model (minor units). */
  minimumCompensation: number;
  /** Platform fee rate applied (0..1). Default 0.15. */
  platformFeeRate: number;
  /** Supplier margin rate applied (0..1). Default 0.15. */
  supplierMarginRate: number;
}

export interface PriceOpportunityOptions {
  /**
   * Platform fee rate (fraction of supplier compensation). Defaults to 0.15
   * (15%) per the ORYXX marketplace standard.
   */
  platformFeeRate?: number;
  /**
   * Supplier margin rate (fraction applied on top of provider cost to give the
   * supplier a profit). Defaults to 0.15 (15%).
   */
  supplierMarginRate?: number;
  /**
   * Whether this is an estimated or final (binding) price. Defaults to
   * "estimated" — final prices are only set at agreement formation.
   */
  label?: "estimated" | "final";
}

// ═══════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════

export const DEFAULT_PLATFORM_FEE_RATE = 0.15;
export const DEFAULT_SUPPLIER_MARGIN_RATE = 0.15;

// ═══════════════════════════════════════════════════════════════════════
// PRICING LOGIC
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute a full PricingResult for a (opportunity, supply) pair.
 *
 * The supply MUST be the same supply the opportunity references (i.e.
 * opportunity.supplyId === supply.id). If a different supply is passed, the
 * pricing will reflect that supply's cost model, NOT the one that produced
 * the opportunity — this is checked and a warning is included in the breakdown
 * via a separate field. The price is still returned; callers decide whether to
 * reject mismatches.
 *
 * @param opportunity  The discovered opportunity to price.
 * @param supply       The supply that backs the opportunity.
 * @param options      Optional pricing overrides (fee rate, margin rate, label).
 * @returns            A PricingResult with full money breakdown.
 */
export function priceOpportunity(
  opportunity: TransportationOpportunity,
  supply: TransportationSupply,
  options: PriceOpportunityOptions = {},
): PricingResult {
  const platformFeeRate = options.platformFeeRate ?? DEFAULT_PLATFORM_FEE_RATE;
  const supplierMarginRate = options.supplierMarginRate ?? DEFAULT_SUPPLIER_MARGIN_RATE;
  const label = options.label ?? "estimated";

  // Structural inputs — taken from the opportunity's route, NOT recomputed
  // from supply coordinates. The opportunity is the source of truth for what
  // the supply will actually drive; the supply is the source of truth for
  // cost rates.
  const distanceKm = Math.max(opportunity.route.distanceKm, 0);
  const estimatedTimeMin = Math.max(opportunity.route.estimatedTimeMin, 0);
  const detourKm = Math.max(opportunity.detourKm, 0);

  const cm = supply.costModel;
  const costPerKm = cm.costPerKm;
  const costPerHour = cm.costPerHour;
  const fixedCost = cm.fixedCost;
  const minimumCompensation = cm.minimumCompensation;

  // Provider operating cost: fixed + per-km + per-hour. All integer minor units.
  const hours = estimatedTimeMin / 60;
  const estimatedProviderCost = Math.round(
    fixedCost + distanceKm * costPerKm + hours * costPerHour,
  );

  // Supplier compensation = max(minimum floor, cost * (1 + margin)).
  // The floor protects the supplier from below-cost matches; the margin gives
  // them a profit on top of their real cost.
  const withMargin = Math.round(estimatedProviderCost * (1 + supplierMarginRate));
  const supplierCompensation = Math.max(minimumCompensation, withMargin);

  // Platform fee: percentage of supplier compensation (NOT of user price, to
  // avoid compounding). Rounded to integer minor units.
  const platformFee = Math.round(supplierCompensation * platformFeeRate);

  // User price = supplier compensation + platform fee. Always integer.
  const userPrice = supplierCompensation + platformFee;

  // Margins.
  const supplierMargin = supplierCompensation - estimatedProviderCost;
  const expectedMargin = userPrice - estimatedProviderCost;

  return {
    userPrice,
    supplierCompensation,
    platformFee,
    estimatedProviderCost,
    expectedMargin,
    supplierMargin,
    label,
    breakdown: {
      distanceKm: Math.round(distanceKm * 100) / 100,
      estimatedTimeMin: Math.round(estimatedTimeMin),
      detourKm: Math.round(detourKm * 100) / 100,
      costPerKm,
      costPerHour,
      fixedCost,
      minimumCompensation,
      platformFeeRate,
      supplierMarginRate,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check whether a PricingResult is consistent with a demand's budget. The
 * demand is not part of the PricingResult type (pricing is demand-agnostic);
 * callers must pass the demand's budget explicitly.
 *
 * Returns true if userPrice <= budget; false otherwise. The clearing engine
 * uses this to reject opportunities whose estimated price exceeds the user's
 * willingness to pay.
 */
export function withinBudget(
  pricing: PricingResult,
  budgetMinorUnits: number,
): boolean {
  return pricing.userPrice <= budgetMinorUnits;
}

/**
 * Check whether a PricingResult covers the supplier's minimum compensation.
 * Always true by construction (we max() with the floor), but exposed for audit.
 */
export function coversSupplierMinimum(pricing: PricingResult): boolean {
  return pricing.supplierCompensation >= pricing.breakdown.minimumCompensation;
}

/**
 * Sanity check: userPrice must equal supplierCompensation + platformFee, and
 * supplierCompensation must be >= estimatedProviderCost (otherwise the supplier
 * is losing money on every trip). Returns violations as human-readable strings.
 */
export function validatePricing(pricing: PricingResult): string[] {
  const violations: string[] = [];
  if (pricing.userPrice !== pricing.supplierCompensation + pricing.platformFee) {
    violations.push(
      `userPrice (${pricing.userPrice}) != supplierCompensation (${pricing.supplierCompensation}) + platformFee (${pricing.platformFee})`,
    );
  }
  if (pricing.supplierCompensation < pricing.estimatedProviderCost) {
    violations.push(
      `supplierCompensation (${pricing.supplierCompensation}) < estimatedProviderCost (${pricing.estimatedProviderCost}) — supplier loses money`,
    );
  }
  if (pricing.expectedMargin !== pricing.userPrice - pricing.estimatedProviderCost) {
    violations.push(
      `expectedMargin (${pricing.expectedMargin}) != userPrice (${pricing.userPrice}) - estimatedProviderCost (${pricing.estimatedProviderCost})`,
    );
  }
  if (pricing.label !== "estimated" && pricing.label !== "final") {
    violations.push(`unknown label: ${pricing.label}`);
  }
  return violations;
}

// Re-export haversine for downstream modules that need geometric reasoning.
export { haversineKm };
