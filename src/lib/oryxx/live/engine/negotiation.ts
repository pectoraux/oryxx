// ORYXX — Live Marketplace Negotiation Engine
//
// Converts a discovered TransportationOpportunity into a Negotiation object
// bounded by a minimum price (supplier reservation), a maximum price (buyer
// budget), and a reservation price (the ORYXX-determined midpoint or anchor).
//
// The negotiation protocol supports five modes:
//   - "fixed-price"            — ORYXX posts a single non-negotiable price
//   - "take-it-or-leave-it"    — one party posts, the other accepts/rejects
//   - "bounded-bargaining"     — multiple rounds within [min, max]
//   - "reverse-auction"        — handled by auction.ts; this stub just records
//                                the auction's outcome as a single round
//   - "sealed-offer"           — each party submits one sealed offer; ORYXX
//                                resolves at the deadline
//
// Money is ALWAYS integer minor units (cents). No floating-point money. No LLM
// ever sets a price or decides acceptance — the rules are deterministic and
// auditable. The maximum number of rounds is hard-capped at MAX_ROUNDS to
// prevent infinite bargaining loops.
//
// Provenance: every Negotiation carries isMarketplaceOpportunity: true and
// researchStimulus: false. Negotiations NEVER produce W3-R/W4-R research
// evidence; they are marketplace-only objects.

import type {
  Negotiation,
  NegotiationRound,
  NegotiationType,
  Provenance,
  TransportationDemand,
  TransportationOpportunity,
  TransportationSupply,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Hard cap on the number of rounds a single Negotiation may contain. Once a
 * negotiation reaches MAX_ROUNDS, further submitRound() calls are rejected
 * and resolveNegotiation() is the only legal operation.
 *
 * This prevents infinite bargaining loops and bounds the audit-trail size.
 * 10 rounds is sufficient for any realistic buyer-supplier dance while
 * guaranteeing deterministic termination.
 */
export const MAX_ROUNDS = 10;

/**
 * Counter bumped on any change to the negotiation algorithm — for audit trail.
 */
export const NEGOTIATION_ENGINE_VERSION = "oryxx-negotiation-v1.0.0";

// ═══════════════════════════════════════════════════════════════════════
// ID GENERATION (deterministic, prefixed for readability in logs)
// ═══════════════════════════════════════════════════════════════════════

let negotiationCounter = 0;

/**
 * Generate a deterministic-ish ID for a Negotiation. Uses the opportunity ID
 * (which is already unique) plus an in-process counter to disambiguate
 * multiple negotiations over the same opportunity (rare but legal — e.g. a
 * re-opened negotiation after the first expired).
 *
 * This is NOT a security-sensitive identifier; it only needs to be unique
 * within a single ORYXX process. For distributed deployments, callers should
 * prefix with their node ID.
 */
function nextNegotiationId(opportunityId: string): string {
  negotiationCounter += 1;
  return `NEG-${opportunityId}-${negotiationCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════
// BOUNDS DERIVATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Derive the minimum, maximum, and reservation price for a negotiation from
 * the underlying demand and supply.
 *
 *   - minimumPrice     = supply.costModel.minimumCompensation
 *                         (the supplier's hard floor; below this they lose money)
 *   - maximumPrice     = min(demand.budget, opportunity.price * 1.5)
 *                         (the buyer's hard ceiling; bounded by the demand's
 *                          stated budget AND a 1.5x sanity check on the
 *                          opportunity's discovered price to prevent runaway
 *                          inflation in bargaining)
 *   - reservationPrice = midpoint of [min, max], rounded to integer minor units
 *                         (the ORYXX-determined anchor; used as the fallback
 *                          clearing price when no round lands exactly on a
 *                          mutually acceptable value)
 *
 * If the demand's budget is below the supplier's minimum, the bounds are
 * degenerate (min > max). The negotiation is still created — callers should
 * check isInfeasible() before relying on it. A degenerate negotiation will
 * always resolve to REJECTED.
 */
export function deriveBounds(
  opportunity: TransportationOpportunity,
  demand: TransportationDemand,
  supply: TransportationSupply,
): {
  minimumPrice: number;
  maximumPrice: number;
  reservationPrice: number;
  infeasible: boolean;
} {
  const minimumPrice = Math.max(0, Math.round(supply.costModel.minimumCompensation));
  const budgetCap = Math.max(0, Math.round(demand.budget));
  // Sanity cap: never let a negotiation's max exceed 1.5x the discovered
  // opportunity price. This prevents a buyer with an inflated budget from
  // being bargained up beyond reason.
  const sanityCap = Math.round(opportunity.price * 1.5);
  const maximumPrice = Math.min(budgetCap, sanityCap);
  const reservationPrice = Math.round((minimumPrice + maximumPrice) / 2);
  const infeasible = minimumPrice > maximumPrice;
  return { minimumPrice, maximumPrice, reservationPrice, infeasible };
}

/**
 * Convenience predicate: are the derived bounds feasible (i.e., is there any
 * price that simultaneously satisfies the supplier's floor and the buyer's
 * ceiling)?
 */
export function isInfeasible(negotiation: Negotiation): boolean {
  return negotiation.minimumPrice > negotiation.maximumPrice;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE NEGOTIATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new Negotiation from a discovered opportunity, its demand, and
 * its supply. The negotiation type determines the protocol:
 *
 *   - "fixed-price"            — ORYXX posts opportunity.price as the sole
 *                                round; resolution is accept-or-reject.
 *   - "take-it-or-leave-it"    — starts empty; the first submitRound() is
 *                                the take-it-or-leave-it offer.
 *   - "bounded-bargaining"     — starts empty; rounds accumulate up to
 *                                MAX_ROUNDS within [min, max].
 *   - "reverse-auction"        — starts empty; the auction winner is recorded
 *                                as the sole round via submitRound() with
 *                                proposer "oryxx".
 *   - "sealed-offer"           — starts empty; each party submits one sealed
 *                                offer via submitRound().
 *
 * The provenance is inherited from the opportunity (which already carries
 * environment, source, observedAt). The negotiation is created in state
 * "OPEN" with zero rounds — even for "fixed-price", the initial round is
 * added by submitRound() with proposer "oryxx" so the audit trail is
 * uniform.
 *
 * @param opportunity  The discovered opportunity to negotiate.
 * @param demand        The demand that backs the opportunity (for budget).
 * @param supply        The supply that backs the opportunity (for floor).
 * @param type          The negotiation protocol to use.
 * @param deadline      ISO timestamp by which the negotiation must resolve.
 * @returns             A new Negotiation in state "OPEN".
 */
export function createNegotiation(
  opportunity: TransportationOpportunity,
  demand: TransportationDemand,
  supply: TransportationSupply,
  type: NegotiationType,
  deadline: string,
): Negotiation {
  const bounds = deriveBounds(opportunity, demand, supply);

  // Provenance is inherited from the opportunity — the negotiation lives in
  // the same environment as the opportunity it negotiates. This is what
  // prevents a SANDBOX opportunity from spawning a LIVE negotiation.
  const provenance: Provenance = {
    environment: opportunity.provenance.environment,
    source: opportunity.provenance.source,
    observedAt: opportunity.provenance.observedAt,
    confidence: opportunity.provenance.confidence,
    validFrom: opportunity.provenance.validFrom,
    validTo: opportunity.provenance.validTo,
  };

  const negotiation: Negotiation = {
    id: nextNegotiationId(opportunity.id),
    opportunityId: opportunity.id,
    demandId: demand.id,
    supplyId: supply.id,
    type,
    minimumPrice: bounds.minimumPrice,
    maximumPrice: bounds.maximumPrice,
    reservationPrice: bounds.reservationPrice,
    deadline,
    rounds: [],
    state: "OPEN",
    provenance,
    isMarketplaceOpportunity: true,
    researchStimulus: false,
    createdAt: new Date().toISOString(),
  };

  // For "fixed-price", ORYXX posts the opportunity's discovered price as the
  // sole round. This makes the audit trail uniform: every negotiation has at
  // least one round by the time it's resolved.
  if (type === "fixed-price") {
    return submitRound(
      negotiation,
      "oryxx",
      opportunity.price,
      "Fixed price posted by ORYXX from discovered opportunity.",
    );
  }

  return negotiation;
}

// ═══════════════════════════════════════════════════════════════════════
// ROUND SUBMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Submit a round to a negotiation. Adds the round to the audit trail, then
 * updates the negotiation state based on the round's price relative to the
 * bounds.
 *
 * Rules:
 *   - Round cap: if rounds.length >= MAX_ROUNDS, the submission is rejected
 *     (throws). The caller must resolveNegotiation() at this point.
 *   - Bounds check:
 *       - price < minimumPrice → round recorded, state stays OPEN/COUNTERED
 *         (supplier-side round below their floor — they're testing the buyer)
 *       - price > maximumPrice → round recorded, state stays OPEN/COUNTERED
 *         (buyer-side round above their ceiling — they're testing the supplier)
 *       - price within [min, max] → state becomes COUNTERED (a feasible
 *         counter has been made; the other party can accept)
 *   - Deadline check: if now > deadline, the negotiation expires (state
 *     becomes EXPIRED) regardless of the submitted price. The round is
 *     still recorded for audit purposes.
 *
 * No LLM is involved. The bounds and state transitions are pure functions
 * of the input.
 *
 * @param negotiation  The negotiation to add a round to.
 * @param proposer     Who is proposing this round ("buyer" | "supplier" | "oryxx").
 * @param price        The proposed price, in integer minor units.
 * @param reason       Optional human-readable reason (for audit only).
 * @returns            A new Negotiation with the round appended and state updated.
 * @throws             If the round cap is exceeded.
 */
export function submitRound(
  negotiation: Negotiation,
  proposer: NegotiationRound["proposer"],
  price: number,
  reason?: string,
): Negotiation {
  // Hard cap: prevent infinite bargaining.
  if (negotiation.rounds.length >= MAX_ROUNDS) {
    throw new Error(
      `Negotiation ${negotiation.id} has reached the round cap (${MAX_ROUNDS}). ` +
        `Call resolveNegotiation() to terminate.`,
    );
  }

  // Round number is 1-indexed for human readability (round 1, 2, 3, ...).
  const round: NegotiationRound = {
    round: negotiation.rounds.length + 1,
    proposer,
    price: Math.round(price),
    timestamp: new Date().toISOString(),
    reason,
  };

  const rounds = [...negotiation.rounds, round];

  // Determine new state.
  let state = negotiation.state;

  // Deadline check overrides everything: an expired negotiation is expired,
  // even if a late round comes in (the round is still recorded for audit).
  const now = Date.now();
  const deadlineMs = Date.parse(negotiation.deadline);
  if (!Number.isNaN(deadlineMs) && now > deadlineMs) {
    state = "EXPIRED";
  } else if (negotiation.state === "OPEN" || negotiation.state === "COUNTERED") {
    // A round within bounds becomes a "COUNTERED" state — a feasible
    // counter has been made. Out-of-bounds rounds keep the negotiation in
    // its current state (OPEN if no feasible round yet, COUNTERED if a
    // previous feasible round is still on the table).
    const withinBounds =
      round.price >= negotiation.minimumPrice && round.price <= negotiation.maximumPrice;
    state = withinBounds ? "COUNTERED" : negotiation.state;
  }

  return { ...negotiation, rounds, state };
}

// ═══════════════════════════════════════════════════════════════════════
// RESOLUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Resolve a negotiation deterministically. The resolution rules depend on
 * the negotiation type:
 *
 *   - "fixed-price": accept iff the (single) posted price is within [min, max].
 *     Final price = posted price.
 *
 *   - "take-it-or-leave-it": accept iff the (single) offer is within [min, max].
 *     Final price = offer.
 *
 *   - "bounded-bargaining": accept iff the LAST round's price is within
 *     [min, max]. Final price = last round's price. If the last round is
 *     out of bounds, fall back to the reservation price (midpoint) — this
 *     is the ORYXX-imposed compromise that ends the negotiation fairly.
 *
 *   - "reverse-auction": the auction engine determines the winner and
 *     clearing price. submitRound() is called once with proposer "oryxx"
 *     and price = clearing price. Resolution accepts iff that price is
 *     within [min, max]. Final price = clearing price.
 *
 *   - "sealed-offer": the buyer and supplier each submit one sealed offer.
 *     If the buyer's offer >= supplier's offer, the negotiation clears at
 *     the midpoint of the two offers (a classic k-double auction with k=0.5).
 *     Otherwise it's rejected.
 *
 * Deadline override: if now > deadline, the negotiation is EXPIRED regardless
 * of the rounds. A negotiation with no rounds is REJECTED (no offer was
 * ever made).
 *
 * Infeasible bounds (min > max): always REJECTED.
 *
 * @param negotiation  The negotiation to resolve.
 * @returns            A new Negotiation with state ACCEPTED/REJECTED/EXPIRED
 *                     and (if accepted) finalPrice set.
 */
export function resolveNegotiation(negotiation: Negotiation): Negotiation {
  // Deadline check first — an expired negotiation cannot be accepted.
  const now = Date.now();
  const deadlineMs = Date.parse(negotiation.deadline);
  if (!Number.isNaN(deadlineMs) && now > deadlineMs) {
    return { ...negotiation, state: "EXPIRED" };
  }

  // Infeasible bounds — no price can satisfy both parties.
  if (isInfeasible(negotiation)) {
    return { ...negotiation, state: "REJECTED" };
  }

  // No rounds submitted — nothing to resolve. Reject.
  if (negotiation.rounds.length === 0) {
    return { ...negotiation, state: "REJECTED" };
  }

  const lastRound = negotiation.rounds[negotiation.rounds.length - 1];
  const min = negotiation.minimumPrice;
  const max = negotiation.maximumPrice;

  let finalPrice: number | undefined;
  let state: Negotiation["state"];

  switch (negotiation.type) {
    case "fixed-price":
    case "take-it-or-leave-it":
    case "reverse-auction": {
      // Single-offer protocols: accept iff the offer is within bounds.
      if (lastRound.price >= min && lastRound.price <= max) {
        finalPrice = lastRound.price;
        state = "ACCEPTED";
      } else {
        state = "REJECTED";
      }
      break;
    }

    case "bounded-bargaining": {
      // Accept the last round if it's within bounds; otherwise fall back to
      // the reservation price (ORYXX-imposed compromise). The reservation
      // price is by construction within [min, max], so this fallback always
      // produces a valid acceptance. This guarantees termination: every
      // bounded-bargaining negotiation either accepts at a party's price
      // or at the reservation price — never infinite.
      if (lastRound.price >= min && lastRound.price <= max) {
        finalPrice = lastRound.price;
      } else {
        finalPrice = negotiation.reservationPrice;
      }
      state = "ACCEPTED";
      break;
    }

    case "sealed-offer": {
      // Sealed-offer: expect exactly two rounds (buyer + supplier). If
      // fewer, reject. If the buyer's offer >= supplier's ask, clear at
      // the midpoint (k=0.5 double auction). Otherwise reject.
      if (negotiation.rounds.length < 2) {
        state = "REJECTED";
        break;
      }
      const buyerRound = negotiation.rounds.find((r) => r.proposer === "buyer");
      const supplierRound = negotiation.rounds.find((r) => r.proposer === "supplier");
      if (!buyerRound || !supplierRound) {
        state = "REJECTED";
        break;
      }
      if (buyerRound.price >= supplierRound.price) {
        // Midpoint clearance — both parties get a fair deal.
        finalPrice = Math.round((buyerRound.price + supplierRound.price) / 2);
        // Sanity: the midpoint must be within [min, max].
        if (finalPrice < min || finalPrice > max) {
          state = "REJECTED";
        } else {
          state = "ACCEPTED";
        }
      } else {
        // No overlap between buyer's offer and supplier's ask — no deal.
        state = "REJECTED";
      }
      break;
    }

    default: {
      // Exhaustiveness check — TypeScript will error here if a new
      // NegotiationType is added without handling it.
      const _exhaustive: never = negotiation.type;
      void _exhaustive;
      state = "REJECTED";
    }
  }

  return { ...negotiation, state, finalPrice };
}

// ═══════════════════════════════════════════════════════════════════════
// QUERIES (for audit / UI)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Has this negotiation reached a terminal state (no more rounds can be
 * submitted)? Terminal states: ACCEPTED, REJECTED, EXPIRED, SETTLED.
 */
export function isTerminal(negotiation: Negotiation): boolean {
  return (
    negotiation.state === "ACCEPTED" ||
    negotiation.state === "REJECTED" ||
    negotiation.state === "EXPIRED" ||
    negotiation.state === "SETTLED"
  );
}

/**
 * Mark a previously-accepted negotiation as SETTLED (e.g. after the payment
 * has been captured). This is a terminal state transition; only ACCEPTED
 * negotiations can be settled.
 */
export function markSettled(negotiation: Negotiation): Negotiation {
  if (negotiation.state !== "ACCEPTED") {
    throw new Error(
      `Cannot settle negotiation ${negotiation.id} in state ${negotiation.state} ` +
        `(only ACCEPTED negotiations can be settled).`,
    );
  }
  return { ...negotiation, state: "SETTLED" };
}

/**
 * Convenience: return the best (most recent feasible) counter-offer in the
 * negotiation, or undefined if none exists. Used by the UI to highlight the
 * "current ask" in a bargaining view.
 */
export function bestCounter(negotiation: Negotiation): NegotiationRound | undefined {
  const feasible = negotiation.rounds.filter(
    (r) => r.price >= negotiation.minimumPrice && r.price <= negotiation.maximumPrice,
  );
  return feasible[feasible.length - 1];
}
