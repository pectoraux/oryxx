// ORYXX — Live Marketplace Reverse-Auction Engine
//
// Reverse auctions are used for the "reverse-auction" negotiation type:
// a demand is broadcast to a set of eligible supplies, each supply submits
// a sealed bid (the price at which they're willing to execute), and ORYXX
// closes the auction by picking a winner according to one of three
// allocation rules:
//
//   - "lowest-feasible-price"        — minimize buyer payment. Winner =
//                                       the lowest bid that is >= minimumPrice
//                                       (supplier floor) and <= maximumPrice
//                                       (buyer ceiling). Pure buyer-optimal.
//
//   - "highest-supplier-surplus"     — maximize supplier surplus. Surplus is
//                                       approximated as (bid - minimumPrice),
//                                       since we don't observe supplier cost
//                                       directly. Winner = the bid that
//                                       maximizes surplus while remaining
//                                       feasible (within [min, max]). This
//                                       rule favors suppliers who bid higher
//                                       (closer to the buyer's ceiling),
//                                       which is the procurement analogue of
//                                       a revenue-maximizing forward auction.
//
//   - "welfare-maximizing"           — maximize (maximumPrice - bid), which
//                                       is the buyer-surplus / welfare
//                                       captured by this allocation. Winner =
//                                       the lowest feasible bid (same as
//                                       lowest-feasible-price), but the
//                                       rationale explicitly optimizes for
//                                       social welfare rather than price
//                                       alone. Ties broken by submission order
//                                       (earliest bid wins, to reward prompt
//                                       responses).
//
// Money is ALWAYS integer minor units (cents). No floating-point money. No LLM
// ever sets a clearing price — the rules are deterministic and auditable.
//
// Provenance: every Auction carries isMarketplaceOpportunity: true and
// researchStimulus: false. Auctions NEVER produce W3-R/W4-R research evidence.

import type {
  Auction,
  AuctionBid,
  AuctionType,
  Provenance,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

export const AUCTION_ENGINE_VERSION = "oryxx-auction-v1.0.0";

// ═══════════════════════════════════════════════════════════════════════
// ID GENERATION (deterministic, prefixed)
// ═══════════════════════════════════════════════════════════════════════

let auctionCounter = 0;

/**
 * Generate a unique Auction ID. Prefixed "AUC-" and suffixed with an
 * in-process counter to disambiguate multiple auctions over the same demand
 * (rare but legal — e.g. re-auctioning after the first winner defaulted).
 */
function nextAuctionId(demandId: string): string {
  auctionCounter += 1;
  return `AUC-${demandId}-${auctionCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE AUCTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new reverse auction for a demand, open to a set of eligible
 * supplies.
 *
 * @param demandId            The demand being auctioned.
 * @param eligibleSupplyIds   Supplies allowed to bid (must be a non-empty
 *                            array; duplicates are silently deduped).
 * @param type                The winner-selection rule.
 * @param startAt             ISO timestamp when bidding opens.
 * @param endAt               ISO timestamp when bidding closes.
 * @param minPrice            Minimum acceptable bid (supplier floor).
 * @param maxPrice            Maximum acceptable bid (buyer ceiling = demand.value).
 * @returns                   A new Auction in state "OPEN".
 */
export function createAuction(
  demandId: string,
  eligibleSupplyIds: string[],
  type: AuctionType,
  startAt: string,
  endAt: string,
  minPrice: number,
  maxPrice: number,
): Auction {
  // Dedupe eligible supply IDs (preserving first-seen order).
  const seen = new Set<string>();
  const eligible: string[] = [];
  for (const id of eligibleSupplyIds) {
    if (!seen.has(id)) {
      seen.add(id);
      eligible.push(id);
    }
  }

  if (eligible.length === 0) {
    throw new Error(
      `Cannot create auction for demand ${demandId}: no eligible supplies.`,
    );
  }

  if (minPrice < 0 || maxPrice < 0) {
    throw new Error("Auction prices must be non-negative integer minor units.");
  }

  if (minPrice > maxPrice) {
    throw new Error(
      `Auction minimumPrice (${minPrice}) cannot exceed maximumPrice (${maxPrice}).`,
    );
  }

  // Provenance: reverse auctions are marketplace objects. They inherit their
  // environment from the caller (the createAuction call is issued by the
  // negotiation engine, which inherits from the opportunity). We default to
  // SANDBOX here — LIVE auctions must be explicitly tagged by a downstream
  // caller (e.g. by setting provenance.environment = "LIVE" before opening).
  const provenance: Provenance = {
    environment: "SANDBOX",
    source: "oryxx-owned",
    observedAt: new Date().toISOString(),
    confidence: 1,
  };

  return {
    id: nextAuctionId(demandId),
    demandId,
    type,
    eligibleSupplyIds: eligible,
    startAt,
    endAt,
    minimumPrice: Math.round(minPrice),
    maximumPrice: Math.round(maxPrice),
    bids: [],
    state: "OPEN",
    provenance,
    isMarketplaceOpportunity: true,
    researchStimulus: false,
    createdAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// BID SUBMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Submit a bid to an open auction. The bid is recorded with a timestamp;
 * rank is left undefined until closeAuction() ranks all bids.
 *
 * Rules:
 *   - The auction must be OPEN.
 *   - The supply must be in the eligible list.
 *   - The bid price must be a non-negative integer.
 *   - A supply may submit multiple bids; only the LATEST bid from each supply
 *     is considered at close (this matches real-world reverse-auction
 *     behavior where bidders can revise down).
 *   - Bids outside [startAt, endAt] are rejected (the auction window is
 *     enforced server-side, not just by client timestamps).
 *
 * No LLM is involved. The bid is recorded verbatim.
 *
 * @param auction     The auction to bid on.
 * @param supplyId    The supply placing the bid.
 * @param providerId  The provider that owns the supply.
 * @param price       The bid price, in integer minor units.
 * @returns           A new Auction with the bid appended.
 * @throws            If the auction is not OPEN, the supply is not eligible,
 *                    or the price is invalid.
 */
export function submitBid(
  auction: Auction,
  supplyId: string,
  providerId: string,
  price: number,
): Auction {
  if (auction.state !== "OPEN") {
    throw new Error(
      `Auction ${auction.id} is not OPEN (state: ${auction.state}); cannot accept bids.`,
    );
  }

  if (!auction.eligibleSupplyIds.includes(supplyId)) {
    throw new Error(
      `Supply ${supplyId} is not eligible to bid in auction ${auction.id}.`,
    );
  }

  if (!Number.isInteger(price) || price < 0) {
    throw new Error(
      `Bid price must be a non-negative integer minor unit; got ${price}.`,
    );
  }

  // Enforce the auction window server-side.
  const now = Date.now();
  const startMs = Date.parse(auction.startAt);
  const endMs = Date.parse(auction.endAt);
  if (!Number.isNaN(startMs) && now < startMs) {
    throw new Error(
      `Auction ${auction.id} has not opened yet (opens at ${auction.startAt}).`,
    );
  }
  if (!Number.isNaN(endMs) && now > endMs) {
    throw new Error(
      `Auction ${auction.id} has closed (ended at ${auction.endAt}); late bids rejected.`,
    );
  }

  const bid: AuctionBid = {
    auctionId: auction.id,
    supplyId,
    providerId,
    price: Math.round(price),
    timestamp: new Date().toISOString(),
  };

  return { ...auction, bids: [...auction.bids, bid] };
}

// ═══════════════════════════════════════════════════════════════════════
// AUCTION CLOSE — WINNER DETERMINATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * The latest bid from each supply. Supplies may revise their bids down over
 * the course of the auction; only the final revision counts.
 */
function latestBidPerSupply(bids: AuctionBid[]): Map<string, AuctionBid> {
  const latest = new Map<string, AuctionBid>();
  for (const b of bids) {
    const prev = latest.get(b.supplyId);
    if (!prev || Date.parse(b.timestamp) >= Date.parse(prev.timestamp)) {
      latest.set(b.supplyId, b);
    }
  }
  return latest;
}

/**
 * A bid is feasible iff it lies within [minimumPrice, maximumPrice]. Bids
 * outside this range cannot be awarded regardless of allocation rule.
 */
function isFeasible(auction: Auction, bid: AuctionBid): boolean {
  return bid.price >= auction.minimumPrice && bid.price <= auction.maximumPrice;
}

/**
 * Close an auction and determine the winner based on its allocation rule.
 *
 * Allocation rules:
 *   - "lowest-feasible-price":      winner = argmin(price) over feasible bids.
 *                                   Tiebreaker: earliest submission (rewards
 *                                   prompt bidders).
 *
 *   - "highest-supplier-surplus":   winner = argmax(price - minimumPrice)
 *                                   over feasible bids. This favors suppliers
 *                                   who bid HIGHER (closer to the buyer's
 *                                   ceiling), capturing more surplus for
 *                                   themselves. Tiebreaker: earliest
 *                                   submission.
 *
 *   - "welfare-maximizing":         winner = argmax(maximumPrice - price)
 *                                   over feasible bids, which is equivalent to
 *                                   argmin(price) — but the rationale field
 *                                   explicitly attributes the choice to welfare
 *                                   maximization rather than price minimization.
 *                                   Tiebreaker: earliest submission.
 *
 * If no feasible bids exist, the auction is CLOSED but not AWARDED — the
 * state becomes "CLOSED" with no winner, and the caller must re-auction or
 * fall back to ordinary routing.
 *
 * @param auction  The auction to close.
 * @returns        A new Auction in state "AWARDED" (with winner + clearing
 *                 price) or "CLOSED" (no feasible bids).
 */
export function closeAuction(auction: Auction): Auction {
  if (auction.state !== "OPEN") {
    throw new Error(
      `Auction ${auction.id} is not OPEN (state: ${auction.state}); cannot close.`,
    );
  }

  // Take only the latest bid from each supply.
  const latestBids = Array.from(latestBidPerSupply(auction.bids).values());

  // Filter to feasible bids (within [min, max]).
  const feasible = latestBids.filter((b) => isFeasible(auction, b));

  // Rank feasible bids by submission order (earliest first) — this is the
  // tiebreaker for all three allocation rules.
  feasible.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  if (feasible.length === 0) {
    // No feasible bids — close without award.
    return {
      ...auction,
      state: "CLOSED",
      reason:
        `No feasible bids (within [${auction.minimumPrice}, ${auction.maximumPrice}]) ` +
        `were submitted; auction closed without award.`,
    };
  }

  // Apply the allocation rule to pick the winner.
  let winner: AuctionBid | undefined;
  let reason: string;

  switch (auction.type) {
    case "lowest-feasible-price": {
      // Lowest feasible bid; tiebreaker = earliest submission (already sorted).
      winner = feasible.reduce((best, b) => (b.price < best.price ? b : best), feasible[0]);
      reason =
        `Winner ${winner.supplyId} submitted the lowest feasible bid ` +
        `(${winner.price} minor units), within [${auction.minimumPrice}, ${auction.maximumPrice}].`;
      break;
    }

    case "highest-supplier-surplus": {
      // Highest surplus = (bid - minimumPrice). Since minimumPrice is constant
      // across bidders, this is equivalent to highest feasible bid. Tiebreaker
      // = earliest submission (already sorted, so the reduce picks the first
      // seen when there's a tie).
      winner = feasible.reduce(
        (best, b) => (b.price > best.price ? b : best),
        feasible[0],
      );
      const surplus = winner.price - auction.minimumPrice;
      reason =
        `Winner ${winner.supplyId} captured the highest supplier surplus ` +
        `(bid ${winner.price} - floor ${auction.minimumPrice} = ${surplus} minor units), ` +
        `within [${auction.minimumPrice}, ${auction.maximumPrice}].`;
      break;
    }

    case "welfare-maximizing": {
      // Maximize (maximumPrice - bid) — equivalent to lowest feasible bid, but
      // the rationale explicitly attributes the choice to welfare maximization.
      winner = feasible.reduce((best, b) => (b.price < best.price ? b : best), feasible[0]);
      const welfare = auction.maximumPrice - winner.price;
      reason =
        `Winner ${winner.supplyId} maximizes welfare ` +
        `(buyer value ${auction.maximumPrice} - bid ${winner.price} = ${welfare} minor units), ` +
        `within [${auction.minimumPrice}, ${auction.maximumPrice}].`;
      break;
    }

    default: {
      // Exhaustiveness check.
      const _exhaustive: never = auction.type;
      void _exhaustive;
      winner = undefined;
      reason = `Unknown auction type: ${auction.type as string}`;
    }
  }

  if (!winner) {
    return {
      ...auction,
      state: "CLOSED",
      reason,
    };
  }

  // Rank all bids (1 = winner) for the audit trail. Only feasible bids are
  // ranked; infeasible bids are left unranked (rank undefined).
  const rankedBids: AuctionBid[] = auction.bids.map((b) => {
    if (!isFeasible(auction, b)) return { ...b, rank: undefined };
    // Rank by (price asc, timestamp asc) — same as the winner determination.
    return { ...b };
  });

  // Sort feasible bids by the rule's natural order and assign ranks.
  const feasibleForRanking = [...feasible].sort((a, b) => {
    if (auction.type === "highest-supplier-surplus") {
      // Higher bid = better rank (rank 1 = highest bid).
      if (b.price !== a.price) return b.price - a.price;
    } else {
      // Lower bid = better rank (rank 1 = lowest bid).
      if (a.price !== b.price) return a.price - b.price;
    }
    return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  });
  feasibleForRanking.forEach((b, i) => {
    const idx = rankedBids.findIndex(
      (rb) =>
        rb.supplyId === b.supplyId && Date.parse(rb.timestamp) === Date.parse(b.timestamp),
    );
    if (idx >= 0) rankedBids[idx] = { ...rankedBids[idx], rank: i + 1 };
  });

  return {
    ...auction,
    bids: rankedBids,
    winnerSupplyId: winner.supplyId,
    clearingPrice: winner.price,
    reason,
    state: "AWARDED",
  };
}

// ═══════════════════════════════════════════════════════════════════════
// QUERIES (for audit / UI)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Has this auction reached a terminal state? Terminal states: AWARDED,
 * CLOSED, CANCELLED.
 */
export function isTerminal(auction: Auction): boolean {
  return (
    auction.state === "AWARDED" ||
    auction.state === "CLOSED" ||
    auction.state === "CANCELLED"
  );
}

/**
 * Mark an OPEN auction as CANCELLED (e.g. the demand was withdrawn). Bids
 * already submitted are preserved for audit but cannot be awarded.
 */
export function cancelAuction(auction: Auction, reason: string): Auction {
  if (auction.state !== "OPEN") {
    throw new Error(
      `Cannot cancel auction ${auction.id} in state ${auction.state} ` +
        `(only OPEN auctions can be cancelled).`,
    );
  }
  return { ...auction, state: "CANCELLED", reason };
}

/**
 * Return the winning bid (if any). Convenience for downstream code that
 * needs both the supply ID and the bid details.
 */
export function winningBid(auction: Auction): AuctionBid | undefined {
  if (auction.state !== "AWARDED" || !auction.winnerSupplyId) return undefined;
  return auction.bids.find(
    (b) => b.supplyId === auction.winnerSupplyId && b.rank === 1,
  );
}
