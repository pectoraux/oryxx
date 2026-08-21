// ORYXX — Availability Broadcast System (NPD / Latent Supply)
//
// The transportation marketplace contains a category of supply that the
// ordinary "dispatch a vehicle to pickup" model misses: vehicles that are
// ALREADY MOVING or ABOUT TO MOVE, with spare capacity, on a known route.
// A trucker leaving Detroit for Chicago with 3 empty pallets; a commuter
// driving from Brooklyn to JFK with 3 empty seats; a courier running a
// scheduled loop with capacity for one more parcel. These are "latent" or
// "non-pre-dispatched" (NPD) supply: the supply exists, has a known
// trajectory, and could absorb additional demand along its route — but
// only if the demand is broadcast in time and the geometry works.
//
// AvailabilityBroadcast is the signal that captures this latent supply. A
// provider (or a fleet operator, or a direct driver) publishes a broadcast
// declaring:
//   - where they are now (currentLocation)
//   - where they are going (destination)
//   - when they depart (departureWindow)
//   - how much spare capacity they have (availableCapacity)
//   - how much detour they tolerate (detourToleranceKm)
//   - their minimum acceptable compensation (minimumCompensation)
//   - their confidence in actually departing as planned (confidence)
//   - when the broadcast expires (expiresAt)
//
// The broadcast lives in one of five states:
//
//   POTENTIAL  — published but not yet offered to any specific demand.
//   OFFERED    — surfaced to a specific demand as a candidate.
//   RESERVED   — capacity tentatively held for a demand (pre-commitment).
//   COMMITTED  — the supply has irrevocably committed to the trip; only
//                COMMITTED broadcasts can back a GUARANTEED execution.
//   EXPIRED    — the broadcast's expiresAt has passed, or the supply has
//                departed without the broadcast being committed.
//
// CRITICAL INVARIANT: Only COMMITTED broadcasts can be used in GUARANTEED
// execution. A POTENTIAL / OFFERED / RESERVED broadcast is a CANDIDATE —
// it can be matched, ranked, and offered, but it cannot back a binding
// agreement until the supply provider has explicitly committed. This is
// what prevents the marketplace from promising capacity that the provider
// has not yet confirmed.
//
// Provenance: every broadcast carries a Provenance (environment / source /
// observedAt / confidence). A SANDBOX broadcast can never back a LIVE
// execution — the environment tag flows through every matching decision.

import type {
  AvailabilityBroadcast,
  BroadcastStatus,
  GeoPoint,
  Provenance,
  ProvenanceSource,
  TimeWindow,
  TransportationDemand,
} from "../types";
import { haversineKm } from "./opportunity-engine";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Broadcast engine version — bumped on any change to the matching algorithm
 * or status transition rules.
 */
export const BROADCAST_ENGINE_VERSION = "oryxx-broadcast-v1.0.0";

/**
 * Multiplier applied to a broadcast's detourToleranceKm when computing the
 * pickup tolerance (how far the supply can divert from its current location
 * to reach a demand's origin). The pickup detour is typically larger than
 * the en-route detour because the supply hasn't yet committed to a specific
 * trajectory — it can still choose its initial heading.
 *
 * A multiplier of 2.0 means a broadcast with detourToleranceKm = 10 km
 * allows a pickup up to 20 km from its currentLocation.
 */
const PICKUP_TOLERANCE_MULTIPLIER = 2.0;

// ═══════════════════════════════════════════════════════════════════════
// ID GENERATION
// ═══════════════════════════════════════════════════════════════════════

let broadcastCounter = 0;

/**
 * Generate a unique AvailabilityBroadcast ID. Prefixed "BCAST-" and suffixed
 * with the provider ID plus an in-process counter, so audit logs read like:
 *   BCAST-{providerId}-{counter}
 */
function nextBroadcastId(providerId: string): string {
  broadcastCounter += 1;
  return `BCAST-${providerId}-${broadcastCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE BROADCAST
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new AvailabilityBroadcast in the POTENTIAL state.
 *
 * The broadcast is created with isCommitted = false — it CANNOT back a
 * guaranteed execution until commitBroadcast() is called (which transitions
 * it to COMMITTED).
 *
 * The `confidence` parameter is clamped to [0, 1]. The `expiresAt`
 * parameter is an ISO timestamp; broadcasts past their expiry are
 * considered EXPIRED (see isExpired).
 *
 * Provenance is REQUIRED — every broadcast must declare its environment
 * (LIVE / SANDBOX / FIXTURE / REPLAY) and source. A SANDBOX broadcast can
 * never back a LIVE execution; the environment tag is the boundary.
 *
 * @param providerId            The provider publishing the broadcast.
 * @param resourceId            The specific vehicle / resource whose
 *                              capacity is being broadcast.
 * @param currentLocation       Where the resource is NOW (or will be at the
 *                              start of the departure window).
 * @param destination           Where the resource is heading.
 * @param departureWindow       When the resource departs (seconds from
 *                              midnight).
 * @param availableCapacity     Spare capacity (seats for people, slots for
 *                              cargo).
 * @param detourToleranceKm     Maximum en-route detour the supply tolerates.
 * @param minimumCompensation   Minimum acceptable compensation, in integer
 *                              minor units (cents).
 * @param confidence            0..1 confidence that the supply will
 *                              actually depart as planned.
 * @param expiresAt             ISO timestamp after which the broadcast is
 *                              considered EXPIRED.
 * @param provenance            The broadcast's provenance (environment /
 *                              source / observedAt / confidence).
 * @returns                    A new AvailabilityBroadcast in POTENTIAL state.
 */
export function createBroadcast(
  providerId: string,
  resourceId: string,
  currentLocation: GeoPoint,
  destination: GeoPoint,
  departureWindow: TimeWindow,
  availableCapacity: number,
  detourToleranceKm: number,
  minimumCompensation: number,
  confidence: number,
  expiresAt: string,
  provenance: Provenance,
): AvailabilityBroadcast {
  if (availableCapacity < 0) {
    throw new Error(
      `availableCapacity must be >= 0 (got ${availableCapacity}).`,
    );
  }
  if (detourToleranceKm < 0) {
    throw new Error(
      `detourToleranceKm must be >= 0 (got ${detourToleranceKm}).`,
    );
  }
  if (minimumCompensation < 0) {
    throw new Error(
      `minimumCompensation must be >= 0 (got ${minimumCompensation}).`,
    );
  }
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error(`expiresAt must be a valid ISO timestamp (got "${expiresAt}").`);
  }

  return {
    id: nextBroadcastId(providerId),
    providerId,
    resourceId,
    currentLocation: { lat: currentLocation.lat, lon: currentLocation.lon, name: currentLocation.name },
    destination: { lat: destination.lat, lon: destination.lon, name: destination.name },
    departureWindow: { startSec: departureWindow.startSec, endSec: departureWindow.endSec },
    availableCapacity: Math.floor(availableCapacity),
    detourToleranceKm,
    minimumCompensation: Math.floor(minimumCompensation),
    confidence: clampUnit(confidence),
    expiresAt,
    status: "POTENTIAL",
    provenance: { ...provenance },
    isCommitted: false,
    createdAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STATUS TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mark a broadcast as EXPIRED. This is a terminal state — an expired
 * broadcast can no longer be matched, offered, reserved, or committed.
 *
 * The expiresAt timestamp is NOT changed; it remains as the originally
 * declared expiry for audit. The status transition is what marks the
 * broadcast as no longer active.
 *
 * @param broadcast  The broadcast to expire.
 * @returns          A new AvailabilityBroadcast with status = "EXPIRED".
 *                   isCommitted is set to false (an expired broadcast is
 *                   never committed, even if it was previously committed —
 *                   expiry overrides commitment).
 */
export function expireBroadcast(
  broadcast: AvailabilityBroadcast,
): AvailabilityBroadcast {
  return {
    ...broadcast,
    status: "EXPIRED",
    isCommitted: false,
  };
}

/**
 * Commit a broadcast. This transitions it to the COMMITTED state, which is
 * the ONLY state from which a guaranteed execution can be backed.
 *
 * Commitment is irrevocable in the sense that once committed, the broadcast
 * cannot return to POTENTIAL / OFFERED / RESERVED — those are pre-commitment
 * candidate states. A committed broadcast can still be EXPIRED (via
 * expireBroadcast) if its expiresAt passes, but it cannot be un-committed.
 *
 * @param broadcast  The broadcast to commit. Must be in a pre-commitment
 *                   state (POTENTIAL / OFFERED / RESERVED). Throws if
 *                   already committed or expired.
 * @returns          A new AvailabilityBroadcast with status = "COMMITTED"
 *                   and isCommitted = true.
 */
export function commitBroadcast(
  broadcast: AvailabilityBroadcast,
): AvailabilityBroadcast {
  if (broadcast.status === "EXPIRED") {
    throw new Error(
      `Cannot commit broadcast ${broadcast.id}: it is EXPIRED.`,
    );
  }
  if (broadcast.status === "COMMITTED") {
    // Idempotent: re-committing an already-committed broadcast is a no-op
    // (returns a structurally equivalent broadcast). This avoids spurious
    // errors when the commitment is recorded redundantly by an upstream
    // system (e.g. a retry after a network blip).
    return { ...broadcast, isCommitted: true };
  }
  return {
    ...broadcast,
    status: "COMMITTED",
    isCommitted: true,
  };
}

/**
 * Offer a broadcast to a specific demand. Transitions a POTENTIAL broadcast
 * to OFFERED. A broadcast already in OFFERED / RESERVED / COMMITTED state
 * is returned unchanged (idempotent for OFFERED; OFFERED is a candidate
 * state that doesn't override RESERVED or COMMITTED).
 *
 * @param broadcast  The broadcast to offer.
 * @returns          A new AvailabilityBroadcast with status = "OFFERED"
 *                   (if it was POTENTIAL) or unchanged (otherwise).
 */
export function offerBroadcast(
  broadcast: AvailabilityBroadcast,
): AvailabilityBroadcast {
  if (broadcast.status === "POTENTIAL") {
    return { ...broadcast, status: "OFFERED" };
  }
  return broadcast;
}

/**
 * Reserve a broadcast's capacity for a specific demand. Transitions an
 * OFFERED (or POTENTIAL) broadcast to RESERVED — capacity is tentatively
 * held, but not yet irrevocably committed.
 *
 * A COMMITTED broadcast stays COMMITTED (you can't un-commit by reserving).
 * An EXPIRED broadcast throws — you can't reserve an expired broadcast.
 *
 * @param broadcast  The broadcast to reserve.
 * @returns          A new AvailabilityBroadcast with status = "RESERVED"
 *                   (or unchanged if already COMMITTED).
 */
export function reserveBroadcast(
  broadcast: AvailabilityBroadcast,
): AvailabilityBroadcast {
  if (broadcast.status === "EXPIRED") {
    throw new Error(
      `Cannot reserve broadcast ${broadcast.id}: it is EXPIRED.`,
    );
  }
  if (broadcast.status === "COMMITTED") {
    // A committed broadcast is already past the reservation stage.
    return broadcast;
  }
  return { ...broadcast, status: "RESERVED" };
}

// ═══════════════════════════════════════════════════════════════════════
// EXPIRY + GUARANTEE CHECKS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Is the broadcast expired? A broadcast is expired if EITHER:
 *   - its status is already "EXPIRED" (explicit expiry), OR
 *   - the current time is past its expiresAt timestamp (implicit expiry).
 *
 * The implicit-expiry check is a pure function of `now` and the broadcast's
 * expiresAt — callers don't need to call expireBroadcast() first for the
 * broadcast to be considered expired.
 *
 * @param broadcast  The broadcast to check.
 * @returns          true if the broadcast is expired.
 */
export function isExpired(broadcast: AvailabilityBroadcast): boolean {
  if (broadcast.status === "EXPIRED") return true;
  const expiryMs = Date.parse(broadcast.expiresAt);
  if (Number.isNaN(expiryMs)) return false; // malformed expiry → not expired
  return Date.now() > expiryMs;
}

/**
 * Can this broadcast back a GUARANTEED execution?
 *
 * The guarantee requires THREE conditions:
 *   1. status === "COMMITTED" (the supply has irrevocably committed to the
 *      trip; POTENTIAL / OFFERED / RESERVED are not enough).
 *   2. isCommitted === true (the redundant boolean flag, kept in sync with
 *      status for fast filtering — checked defensively in case of skew).
 *   3. The broadcast is NOT expired (a committed broadcast whose expiresAt
 *      has passed can no longer guarantee execution).
 *
 * If any condition fails, the broadcast can still be matched, ranked, and
 * offered — but it CANNOT be used to back a binding agreement or execution.
 *
 * @param broadcast  The broadcast to check.
 * @returns          true iff the broadcast can back a guaranteed execution.
 */
export function isGuaranteed(broadcast: AvailabilityBroadcast): boolean {
  if (isExpired(broadcast)) return false;
  return broadcast.status === "COMMITTED" && broadcast.isCommitted === true;
}

/**
 * Is the broadcast still ACTIVE (eligible for matching)?
 *
 * A broadcast is active iff it is NOT expired AND NOT in a terminal state
 * (EXPIRED). COMMITTED broadcasts are still active — they can be matched
 * even after commitment (e.g. for additional demand along the route).
 *
 * @param broadcast  The broadcast to check.
 * @returns          true iff the broadcast is active.
 */
export function isActive(broadcast: AvailabilityBroadcast): boolean {
  return !isExpired(broadcast);
}

// ═══════════════════════════════════════════════════════════════════════
// MATCHING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Do two time windows (in seconds-from-midnight) overlap?
 *
 * Overlap is half-open: windows that share only an endpoint (e.g.
 * [09:00, 10:00] and [10:00, 11:00]) are considered NON-overlapping. This
 * is the standard convention for "can the supply serve the demand at any
 * common moment?" — a supply departing exactly when the demand window ends
 * cannot serve it.
 *
 * The function does NOT handle windows that span midnight (e.g.
 * [23:00, 02:00]); the TimeWindow type uses seconds-from-midnight and
 * implicitly assumes same-day windows. Callers with cross-midnight demand
 * should split it into two windows.
 */
function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return Math.max(a.startSec, b.startSec) < Math.min(a.endSec, b.endSec);
}

/**
 * Perpendicular distance (km) from a point P to the great-circle segment
 * A->B. Uses a local equirectangular projection to compute the projection
 * parameter `t`, then haversine for the final distance.
 *
 * This is the same algorithm used by opportunity-engine.ts's
 * pointToSegmentKm — duplicated locally to avoid creating an upward
 * dependency from this matching helper to the opportunity engine's
 * internal geometry. If t < 0 or t > 1, the closest point is one of the
 * segment endpoints, and the distance is the haversine to that endpoint.
 */
function pointToSegmentKm(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const kx = Math.cos(lat0) * 111.32; // km per degree of longitude
  const ky = 111.32; // km per degree of latitude
  const ax = a.lon * kx, ay = a.lat * ky;
  const bx = b.lon * kx, by = b.lat * ky;
  const px = p.lon * kx, py = p.lat * ky;
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const proj: GeoPoint = { lat: (ay + t * aby) / ky, lon: (ax + t * abx) / kx };
  return haversineKm(p, proj);
}

/**
 * Derive the required capacity for a demand, in the same units as a
 * broadcast's availableCapacity.
 *
 *   - person / people  → partySize (number of seats needed)
 *   - parcel / pallet / container → 1 (one cargo slot)
 *
 * This is a coarse mapping. Real systems would model cargo capacity in
 * weight / volume and check both dimensions; for the broadcast matcher,
 * a single scalar capacity is sufficient (broadcasts that carry cargo
 * already encode their per-slot weight/volume limits in their underlying
 * TransportationResource, which is checked separately by the opportunity
 * engine's kind-compatibility + capacity logic).
 */
function requiredCapacityFor(demand: TransportationDemand): number {
  if (demand.kind === "person" || demand.kind === "people") {
    return Math.max(1, demand.partySize);
  }
  // parcel / pallet / container: one slot.
  return 1;
}

/**
 * Does the broadcast's spatial trajectory serve the demand's origin and
 * destination?
 *
 * The broadcast's effective route is the great-circle segment from
 * currentLocation to destination. The demand is spatially servable if:
 *
 *   - demand.origin is within pickupTolerance of the START of the segment
 *     (currentLocation). pickupTolerance = detourToleranceKm *
 *     PICKUP_TOLERANCE_MULTIPLIER — the supply can divert from its current
 *     position to reach the pickup.
 *
 *   - demand.destination is within detourToleranceKm of the SEGMENT (not
 *     just the endpoint). This allows dropoff anywhere along the route,
 *     within the supply's detour tolerance. This is the key check that
 *     captures latent supply: a truck heading Detroit->Chicago can serve
 *     a demand from Toledo->Gary because both points are along the route.
 *
 *   - demand.origin is also within detourToleranceKm of the SEGMENT (not
 *     just the start). This is a stricter version of the pickup check —
 *     it allows pickup at any point along the route, not just at the
 *     supply's current location. We use the looser of (pickupTolerance
 *     from start, detourToleranceKm from segment) by checking both.
 *
 * Returns the per-point detour distances and a boolean `feasible` flag.
 */
function spatialMatch(
  broadcast: AvailabilityBroadcast,
  demand: TransportationDemand,
): {
  feasible: boolean;
  pickupDetourKm: number;
  dropoffDetourKm: number;
} {
  // Pickup: distance from demand.origin to the supply's current location
  // (pickupTolerance) OR to the supply's segment (detourToleranceKm).
  const pickupFromStart = haversineKm(demand.origin, broadcast.currentLocation);
  const pickupFromSegment = pointToSegmentKm(
    demand.origin,
    broadcast.currentLocation,
    broadcast.destination,
  );
  const pickupDetourKm = Math.min(pickupFromStart, pickupFromSegment);
  const pickupTolerance = broadcast.detourToleranceKm * PICKUP_TOLERANCE_MULTIPLIER;
  const pickupOk = pickupDetourKm <= Math.max(pickupTolerance, broadcast.detourToleranceKm);

  // Dropoff: distance from demand.destination to the supply's segment.
  const dropoffDetourKm = pointToSegmentKm(
    demand.destination,
    broadcast.currentLocation,
    broadcast.destination,
  );
  const dropoffOk = dropoffDetourKm <= broadcast.detourToleranceKm;

  return {
    feasible: pickupOk && dropoffOk,
    pickupDetourKm: Math.round(pickupDetourKm * 1000) / 1000,
    dropoffDetourKm: Math.round(dropoffDetourKm * 1000) / 1000,
  };
}

/**
 * Does the broadcast's time window serve the demand's time window?
 *
 * The broadcast's departureWindow must overlap with the demand's
 * timeWindow (the demand's pickup window). The demand's latestArrivalSec
 * is NOT checked here — that requires knowing the travel time, which is
 * the opportunity engine's job. The broadcast matcher only checks the
 * pickup-window overlap.
 */
function temporalMatch(
  broadcast: AvailabilityBroadcast,
  demand: TransportationDemand,
): boolean {
  return windowsOverlap(broadcast.departureWindow, demand.timeWindow);
}

/**
 * Does the broadcast have enough spare capacity for the demand?
 */
function capacityMatch(
  broadcast: AvailabilityBroadcast,
  demand: TransportationDemand,
): boolean {
  return broadcast.availableCapacity >= requiredCapacityFor(demand);
}

/**
 * Find all broadcasts that could serve a given demand.
 *
 * A broadcast "could serve" a demand iff ALL of the following hold:
 *
 *   1. ACTIVE: the broadcast is not expired (status !== EXPIRED and
 *      expiresAt is in the future). Expired broadcasts are excluded even
 *      if they otherwise match.
 *
 *   2. SPATIAL: the demand's origin and destination are both within the
 *      broadcast's detour tolerance of its effective route
 *      (currentLocation -> destination). See spatialMatch() for details.
 *
 *   3. TEMPORAL: the broadcast's departureWindow overlaps with the demand's
 *      timeWindow (pickup window). The demand's latestArrivalSec is NOT
 *      checked here — that requires travel-time estimation, which is the
 *      opportunity engine's job.
 *
 *   4. CAPACITY: the broadcast's availableCapacity >= the demand's required
 *      capacity (partySize for people; 1 for cargo).
 *
 * The result is sorted by a heuristic "match quality" score that combines:
 *   - spatial proximity (closer pickup/dropoff = better)
 *   - temporal proximity (more overlap = better)
 *   - confidence (higher = better)
 *   - capacity fit (less wasted capacity = better — a broadcast with
 *     exactly the right capacity is preferred over one with 10x spare)
 *
 * IMPORTANT: The result may include NON-COMMITTED broadcasts (POTENTIAL /
 * OFFERED / RESERVED). These can be MATCHED and OFFERED but CANNOT back a
 * GUARANTEED execution. Callers that need guaranteed execution must filter
 * the result with isGuaranteed(). The `committedOnly` parameter does this
 * filtering automatically when true.
 *
 * @param broadcasts      The pool of broadcasts to search.
 * @param demand          The demand to match against.
 * @param committedOnly  If true, return only COMMITTED broadcasts (those
 *                        that can back a guaranteed execution). Defaults
 *                        to false (return all matching active broadcasts).
 * @returns              Matching broadcasts, sorted by match quality
 *                        descending. Empty if none match.
 */
export function findMatchingBroadcasts(
  broadcasts: AvailabilityBroadcast[],
  demand: TransportationDemand,
  committedOnly: boolean = false,
): AvailabilityBroadcast[] {
  const candidates: {
    broadcast: AvailabilityBroadcast;
    score: number;
    pickupDetourKm: number;
    dropoffDetourKm: number;
  }[] = [];

  for (const broadcast of broadcasts) {
    // 1. Active + (optional) committed-only filter.
    if (!isActive(broadcast)) continue;
    if (committedOnly && !isGuaranteed(broadcast)) continue;

    // 2. Spatial match.
    const spatial = spatialMatch(broadcast, demand);
    if (!spatial.feasible) continue;

    // 3. Temporal match.
    if (!temporalMatch(broadcast, demand)) continue;

    // 4. Capacity match.
    if (!capacityMatch(broadcast, demand)) continue;

    // Compute a match-quality score in [0, 1] (higher = better).
    // Weighted sum of normalized spatial, temporal, confidence, and
    // capacity-fit sub-scores.
    const spatialScore =
      1 - (spatial.pickupDetourKm + spatial.dropoffDetourKm) /
            (2 * Math.max(broadcast.detourToleranceKm, 0.001));
    const temporalOverlap = Math.max(
      0,
      Math.min(broadcast.departureWindow.endSec, demand.timeWindow.endSec) -
        Math.max(broadcast.departureWindow.startSec, demand.timeWindow.startSec),
    );
    const demandWindowSpan = Math.max(
      1,
      demand.timeWindow.endSec - demand.timeWindow.startSec,
    );
    const temporalScore = Math.min(1, temporalOverlap / demandWindowSpan);
    const confidenceScore = clampUnit(broadcast.confidence);
    const required = requiredCapacityFor(demand);
    const capacityScore =
      broadcast.availableCapacity <= 0
        ? 0
        : Math.min(1, required / broadcast.availableCapacity);

    const score =
      0.35 * clampUnit(spatialScore) +
      0.25 * temporalScore +
      0.25 * confidenceScore +
      0.15 * capacityScore;

    candidates.push({
      broadcast,
      score,
      pickupDetourKm: spatial.pickupDetourKm,
      dropoffDetourKm: spatial.dropoffDetourKm,
    });
  }

  // Sort by score descending; tiebreak by closer pickup, then closer dropoff,
  // then by broadcast ID for deterministic output.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.pickupDetourKm !== b.pickupDetourKm) return a.pickupDetourKm - b.pickupDetourKm;
    if (a.dropoffDetourKm !== b.dropoffDetourKm) return a.dropoffDetourKm - b.dropoffDetourKm;
    return a.broadcast.id < b.broadcast.id ? -1 : a.broadcast.id > b.broadcast.id ? 1 : 0;
  });

  return candidates.map((c) => c.broadcast);
}

/**
 * Convenience wrapper: find only COMMITTED broadcasts that match a demand.
 * Equivalent to findMatchingBroadcasts(broadcasts, demand, true). The
 * returned broadcasts can all back a guaranteed execution (subject to a
 * final isExpired re-check at execution time — a broadcast could expire
 * between matching and execution).
 */
export function findGuaranteedBroadcasts(
  broadcasts: AvailabilityBroadcast[],
  demand: TransportationDemand,
): AvailabilityBroadcast[] {
  return findMatchingBroadcasts(broadcasts, demand, true);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Clamp a number to [0, 1]. */
function clampUnit(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Categorize a list of broadcasts by status. Useful for dashboards that
 * show "how much supply is POTENTIAL vs. OFFERED vs. RESERVED vs.
 * COMMITTED vs. EXPIRED".
 */
export function categorizeByStatus(
  broadcasts: AvailabilityBroadcast[],
): Record<BroadcastStatus, AvailabilityBroadcast[]> {
  const result: Record<BroadcastStatus, AvailabilityBroadcast[]> = {
    POTENTIAL: [],
    OFFERED: [],
    RESERVED: [],
    COMMITTED: [],
    EXPIRED: [],
  };
  for (const b of broadcasts) {
    // Use the effective status (EXPIRED if implicitly expired).
    const status: BroadcastStatus = isExpired(b) && b.status !== "COMMITTED"
      ? "EXPIRED"
      : b.status;
    result[status].push(b);
  }
  return result;
}

/**
 * Sum the available capacity across a list of broadcasts. Useful for
 * dashboards that show "total latent supply in the system right now".
 *
 * Expired broadcasts are excluded from the sum.
 */
export function totalAvailableCapacity(
  broadcasts: AvailabilityBroadcast[],
): number {
  return broadcasts
    .filter(isActive)
    .reduce((sum, b) => sum + b.availableCapacity, 0);
}
