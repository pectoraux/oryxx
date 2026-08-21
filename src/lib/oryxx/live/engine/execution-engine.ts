// ORYXX — Live Marketplace Execution Engine
//
// Converts a MarketplaceAgreement into a TransportationExecution, then drives
// it through a strict state machine from OPPORTUNITY_CREATED to COMPLETED
// (or to one of the failure states: EXPIRED, CANCELLED, FAILED, NO_SHOW,
// UNFULFILLED).
//
// The state machine enforces the marketplace execution lifecycle:
//
//   OPPORTUNITY_CREATED
//        ↓
//      OFFERED                  (offer presented to the user)
//        ↓
//     ACCEPTED                  (user accepted → can produce W3-M if LIVE)
//        ↓
//     RESERVED                  (supply reserved; escrow authorized)
//        ↓
//    DISPATCHED                 (driver dispatched; vehicle en route to pickup)
//        ↓
//     EN_ROUTE                  (vehicle moving toward pickup)
//        ↓
//    PICKED_UP                  (passenger / freight on board)
//        ↓
//    EXECUTING                  (in transit to destination)
//        ↓
//     COMPLETED                 (delivered → can produce W4-M if LIVE + verified)
//
// Failure states (reachable from various non-terminal states):
//   - EXPIRED     — deadline passed before ACCEPTED
//   - CANCELLED   — user or ORYXX cancelled before pickup
//   - FAILED      — supplier could not execute (e.g. vehicle broke down)
//   - NO_SHOW     — supplier did not show up at pickup
//   - UNFULFILLED — execution completed but did not meet demand constraints
//
// Every execution is tagged:
//   - isMarketplaceOpportunity: true   (always)
//   - researchStimulus: false          (always — these are NOT research stimuli)
//   - evidenceEligible: true only if environment === "LIVE"
//
// Marketplace evidence rules (re-exported from ../types for convenience):
//   - W3-M requires LIVE + ACCEPTED-or-later state.
//   - W4-M requires LIVE + COMPLETED + independent verification.
//   - SANDBOX / FIXTURE / REPLAY executions can NEVER produce W3-M/W4-M.
//   - Research stimuli can NEVER produce W3-M/W4-M.

import type {
  ExecutionState,
  MarketplaceAgreement,
  Provenance,
  TransportationExecution,
  TransportationOpportunity,
} from "../types";
// Re-export the canonical marketplace evidence helper so callers can reach it
// through the execution engine without knowing about the types module path.
// We also bind it locally as `canProduceMarketplaceEvidence` so that
// canProduceEvidence() below can delegate to the canonical implementation
// (single source of truth — this module never overrides the rules).
import { canProduceMarketplaceEvidence } from "../types";
export { canProduceMarketplaceEvidence, MARKETPLACE_EVIDENCE_RULES } from "../types";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

export const EXECUTION_ENGINE_VERSION = "oryxx-execution-v1.0.0";

/**
 * The forward lifecycle of a marketplace execution. Each entry's state can
 * only transition to the next entry's state (e.g. ACCEPTED → RESERVED).
 *
 * Failure states (EXPIRED, CANCELLED, FAILED, NO_SHOW, UNFULFILLED) are
 * reachable from any non-terminal forward state, but once entered they are
 * terminal — no further transitions are allowed.
 */
export const FORWARD_LIFECYCLE: ExecutionState[] = [
  "OPPORTUNITY_CREATED",
  "OFFERED",
  "ACCEPTED",
  "RESERVED",
  "DISPATCHED",
  "EN_ROUTE",
  "PICKED_UP",
  "EXECUTING",
  "COMPLETED",
];

/**
 * Failure (terminal) states. Once an execution enters one of these states,
 * no further transitions are allowed.
 */
export const FAILURE_STATES: ExecutionState[] = [
  "EXPIRED",
  "CANCELLED",
  "FAILED",
  "NO_SHOW",
  "UNFULFILLED",
];

/**
 * States from which the W3-M evidence tier can be produced (when combined
 * with LIVE environment + evidenceEligible). Per the canonical rules in
 * ../types.ts, W3-M requires ACCEPTED-or-later.
 */
export const W3M_ELIGIBLE_STATES: ExecutionState[] = [
  "ACCEPTED",
  "RESERVED",
  "DISPATCHED",
  "EN_ROUTE",
  "PICKED_UP",
  "EXECUTING",
  "COMPLETED",
];

/**
 * The single state from which the W4-M evidence tier can be produced (when
 * combined with LIVE environment + evidenceEligible + independent
 * verification). W4-M requires COMPLETED.
 */
export const W4M_ELIGIBLE_STATE: ExecutionState = "COMPLETED";

// ═══════════════════════════════════════════════════════════════════════
// ID GENERATION
// ═══════════════════════════════════════════════════════════════════════

let executionCounter = 0;

/**
 * Generate a unique Execution ID, prefixed "EXE-" and suffixed with an
 * in-process counter. The agreement ID is included for traceability.
 */
function nextExecutionId(agreementId: string): string {
  executionCounter += 1;
  return `EXE-${agreementId}-${executionCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════

/**
 * The legal transitions of the execution state machine.
 *
 * Each key is a source state; each value is the set of states that may be
 * transitioned to from that source. Forward transitions follow the
 * FORWARD_LIFECYCLE order; failure transitions are allowed from any
 * non-terminal forward state.
 *
 * The COMPLETED state is terminal — it has no outgoing transitions.
 * Failure states are also terminal.
 */
const LEGAL_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  // Forward lifecycle: each state can transition to the next forward state,
  // OR to any failure state appropriate for that stage.
  OPPORTUNITY_CREATED: ["OFFERED", "EXPIRED", "CANCELLED"],
  OFFERED: ["ACCEPTED", "EXPIRED", "CANCELLED", "FAILED"],
  ACCEPTED: ["RESERVED", "CANCELLED", "FAILED"],
  RESERVED: ["DISPATCHED", "CANCELLED", "FAILED"],
  DISPATCHED: ["EN_ROUTE", "CANCELLED", "FAILED", "NO_SHOW"],
  EN_ROUTE: ["PICKED_UP", "CANCELLED", "FAILED", "NO_SHOW"],
  PICKED_UP: ["EXECUTING", "FAILED"],
  EXECUTING: ["COMPLETED", "FAILED", "UNFULFILLED"],
  COMPLETED: [], // terminal — no further transitions
  // Failure states: all terminal.
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
  NO_SHOW: [],
  UNFULFILLED: [],
};

/**
 * Is the given state a terminal state (no further transitions allowed)?
 *
 * Terminal states are: COMPLETED (success) and all failure states
 * (EXPIRED, CANCELLED, FAILED, NO_SHOW, UNFULFILLED).
 */
export function isTerminal(state: ExecutionState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}

/**
 * Is transitioning from `from` to `to` legal under the state machine?
 *
 * Legal transitions are:
 *   - Forward: from FORWARD_LIFECYCLE[i] to FORWARD_LIFECYCLE[i+1]
 *   - Forward-skip: from FORWARD_LIFECYCLE[i] to FORWARD_LIFECYCLE[j] where
 *     j > i+1 (e.g. ACCEPTED → DISPATCHED if reservation was a no-op). This
 *     is allowed because some providers skip states (e.g. a taxi dispatch
 *     may go straight from ACCEPTED to EN_ROUTE without an explicit
 *     RESERVED step).
 *   - Failure: from any non-terminal forward state to any failure state
 *     that's legal at that stage (see LEGAL_TRANSITIONS).
 *
 * The state machine refuses to "go backwards" (e.g. from DISPATCHED back
 * to ACCEPTED) — that would represent an inconsistency in the execution
 * lifecycle and is rejected.
 */
export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  if (from === to) return false; // no-op transitions are not legal (they're noise)
  const allowed = LEGAL_TRANSITIONS[from];
  if (allowed.includes(to)) return true;

  // Forward-skip: allow transitioning from any forward state to any later
  // forward state (e.g. ACCEPTED → EN_ROUTE, skipping RESERVED + DISPATCHED).
  // This accommodates providers whose lifecycle is coarser than ORYXX's
  // canonical model.
  const fromIdx = FORWARD_LIFECYCLE.indexOf(from);
  const toIdx = FORWARD_LIFECYCLE.indexOf(to);
  if (fromIdx >= 0 && toIdx >= 0 && toIdx > fromIdx) {
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE EXECUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new TransportationExecution from a MarketplaceAgreement and the
 * opportunity that backs it.
 *
 * The execution starts in state OPPORTUNITY_CREATED — even though the
 * agreement implies the offer was already accepted, the execution lifecycle
 * is a separate concern from the agreement lifecycle. The first transition
 * (typically to OFFERED, then ACCEPTED) is the responsibility of the
 * execution driver. The state machine guarantees the lifecycle is monotonic.
 *
 * Environment + evidence eligibility:
 *   - The execution's environment is inherited from the agreement's
 *     provenance. A SANDBOX agreement produces a SANDBOX execution; a LIVE
 *     agreement produces a LIVE execution.
 *   - `evidenceEligible` is true iff environment === "LIVE". Sandbox and
 *     fixture executions can NEVER produce W3-M/W4-M marketplace evidence
 *     (see canProduceEvidence()).
 *   - All executions are tagged isMarketplaceOpportunity: true and
 *     researchStimulus: false — they are marketplace objects, not research
 *     stimuli, and they can NEVER produce W3-R/W4-R research evidence.
 *
 * @param agreement    The accepted agreement to execute.
 * @param opportunity  The opportunity the agreement was based on.
 * @returns            A new TransportationExecution in state OPPORTUNITY_CREATED.
 */
export function createExecution(
  agreement: MarketplaceAgreement,
  opportunity: TransportationOpportunity,
): TransportationExecution {
  // Validate that the agreement and opportunity are consistent. They must
  // reference the same demand, supply, and opportunity.
  if (agreement.opportunityId !== opportunity.id) {
    throw new Error(
      `Agreement ${agreement.id} references opportunity ${agreement.opportunityId}, ` +
        `but createExecution was called with opportunity ${opportunity.id}.`,
    );
  }
  if (agreement.demandId !== opportunity.demandId) {
    throw new Error(
      `Agreement ${agreement.id} (demand ${agreement.demandId}) does not match ` +
        `opportunity ${opportunity.id} (demand ${opportunity.demandId}).`,
    );
  }
  if (agreement.supplyId !== opportunity.supplyId) {
    throw new Error(
      `Agreement ${agreement.id} (supply ${agreement.supplyId}) does not match ` +
        `opportunity ${opportunity.id} (supply ${opportunity.supplyId}).`,
    );
  }

  // Inherit environment from the agreement's provenance — the execution
  // lives in the same environment as the agreement that authorized it.
  const environment = agreement.provenance.environment;

  // Evidence eligibility: ONLY LIVE executions can ever produce W3-M/W4-M.
  // Sandbox and fixture executions are explicitly marked ineligible so the
  // evidence verifier can reject them without inspecting state.
  const evidenceEligible = environment === "LIVE";

  // Provenance is inherited and augmented with a fresh observedAt timestamp
  // for the execution event.
  const provenance: Provenance = {
    environment,
    source: agreement.provenance.source,
    observedAt: new Date().toISOString(),
    confidence: agreement.provenance.confidence,
    validFrom: agreement.provenance.validFrom,
    validTo: agreement.provenance.validTo,
  };

  return {
    id: nextExecutionId(agreement.id),
    agreementId: agreement.id,
    opportunityId: opportunity.id,
    demandId: agreement.demandId,
    supplyId: agreement.supplyId,
    providerId: agreement.providerId,
    state: "OPPORTUNITY_CREATED",
    environment,
    evidenceEligible,
    provenance,
    isMarketplaceOpportunity: true,
    researchStimulus: false,
    createdAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Transition an execution to a new state.
 *
 * Validates that the transition is legal under the state machine (see
 * canTransition()). If legal, returns a new TransportationExecution with
 * the updated state. If the new state is COMPLETED, sets completedAt. If
 * the new state is a failure state, the caller may provide a failureReason
 * via the optional third argument.
 *
 * Refuses to transition:
 *   - From a terminal state (COMPLETED, EXPIRED, CANCELLED, FAILED, NO_SHOW,
 *     UNFULFILLED) — terminal states are final.
 *   - To an illegal state (see canTransition()).
 *   - To the current state (no-op transitions are noise; rejected).
 *
 * The environment, evidenceEligible, isMarketplaceOpportunity, and
 * researchStimulus fields are IMMUTABLE — they're set at creation and never
 * change. This is what guarantees that a SANDBOX execution can never
 * "promote itself" to LIVE.
 *
 * @param execution       The execution to transition.
 * @param newState        The target state.
 * @param failureReason   Optional human-readable reason (required for failure
 *                        states, ignored otherwise).
 * @returns               A new TransportationExecution in the target state.
 * @throws                If the transition is illegal or the execution is terminal.
 */
export function transition(
  execution: TransportationExecution,
  newState: ExecutionState,
  failureReason?: string,
): TransportationExecution {
  if (isTerminal(execution.state)) {
    throw new Error(
      `Execution ${execution.id} is in terminal state ${execution.state}; ` +
        `no further transitions are allowed.`,
    );
  }

  if (!canTransition(execution.state, newState)) {
    throw new Error(
      `Illegal transition for execution ${execution.id}: ` +
        `${execution.state} → ${newState}.`,
    );
  }

  // Failure states require a reason (for audit). Success states ignore it.
  if (FAILURE_STATES.includes(newState) && !failureReason) {
    throw new Error(
      `Transition to failure state ${newState} for execution ${execution.id} ` +
        `requires a failureReason (for audit).`,
    );
  }

  const updated: TransportationExecution = {
    ...execution,
    state: newState,
    failureReason: FAILURE_STATES.includes(newState) ? failureReason : undefined,
  };

  // Set lifecycle timestamps.
  if (newState === "COMPLETED") {
    updated.completedAt = new Date().toISOString();
  }
  // startedAt: set when execution truly begins moving (DISPATCHED or later).
  // We set it lazily — only if it's not already set and we've reached
  // DISPATCHED-or-later.
  if (
    !updated.startedAt &&
    FORWARD_LIFECYCLE.indexOf(newState) >= FORWARD_LIFECYCLE.indexOf("DISPATCHED")
  ) {
    updated.startedAt = new Date().toISOString();
  }

  return updated;
}

// ═══════════════════════════════════════════════════════════════════════
// EVIDENCE ELIGIBILITY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Determine whether this execution can produce marketplace evidence
 * (W3-M = acceptance, W4-M = completion).
 *
 * Rules (canonical, defined in ../types.ts):
 *   - W3-M requires: environment === "LIVE" AND evidenceEligible AND
 *                    state is ACCEPTED-or-later (i.e. the supply has
 *                    committed to executing).
 *   - W4-M requires: environment === "LIVE" AND evidenceEligible AND
 *                    state === "COMPLETED" AND independent verification
 *                    (the verification step is OUTSIDE the engine — the
 *                    caller is responsible for confirming it before issuing
 *                    a W4-M evidence record).
 *
 * SANDBOX / FIXTURE / REPLAY executions can NEVER produce W3-M/W4-M,
 * regardless of state — their evidenceEligible flag is false by construction.
 *
 * Research stimuli can NEVER produce W3-M/W4-M — but research stimuli are
 * a separate type (not TransportationExecution), so this method does not
 * apply to them.
 *
 * @param execution  The execution to check.
 * @returns          `{ w3m, w4m, reason }` — true iff the engine would
 *                   issue the evidence tier; the reason string explains
 *                   why (or why not) for audit.
 */
export function canProduceEvidence(
  execution: TransportationExecution,
): { w3m: boolean; w4m: boolean; reason: string } {
  // Delegate to the canonical implementation in ../types.ts. This is the
  // single source of truth — the execution engine does NOT override the
  // rules, it just re-exposes them for ergonomic access from execution-
  // focused call sites.
  return canProduceMarketplaceEvidence(execution);
}

// ═══════════════════════════════════════════════════════════════════════
// CONVENIENCE TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convenience: offer the execution (OPPORTUNITY_CREATED → OFFERED).
 * Represents the moment the user is presented with the offer.
 */
export function offer(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "OFFERED");
}

/**
 * Convenience: accept the offer (OFFERED → ACCEPTED).
 * Once accepted, a LIVE execution can produce W3-M evidence.
 */
export function accept(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "ACCEPTED");
}

/**
 * Convenience: reserve the supply (ACCEPTED → RESERVED).
 * Typically called after the escrow payment is authorized.
 */
export function reserve(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "RESERVED");
}

/**
 * Convenience: dispatch the supply (RESERVED → DISPATCHED).
 * The driver / vehicle is now assigned and moving toward the pickup.
 */
export function dispatch(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "DISPATCHED");
}

/**
 * Convenience: mark the vehicle as en route to pickup (DISPATCHED → EN_ROUTE).
 */
export function markEnRoute(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "EN_ROUTE");
}

/**
 * Convenience: mark the passenger / freight as picked up (EN_ROUTE → PICKED_UP).
 */
export function markPickedUp(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "PICKED_UP");
}

/**
 * Convenience: mark the trip as executing (PICKED_UP → EXECUTING).
 */
export function markExecuting(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "EXECUTING");
}

/**
 * Convenience: mark the trip as completed (EXECUTING → COMPLETED).
 * Once completed, a LIVE execution can produce W4-M evidence (after
 * independent verification by the evidence layer).
 */
export function complete(execution: TransportationExecution): TransportationExecution {
  return transition(execution, "COMPLETED");
}

// ═══════════════════════════════════════════════════════════════════════
// FAILURE TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mark an execution as expired (e.g. the offer deadline passed before
 * acceptance). Only legal from OPPORTUNITY_CREATED or OFFERED.
 */
export function expire(
  execution: TransportationExecution,
  reason: string = "Deadline passed before acceptance.",
): TransportationExecution {
  return transition(execution, "EXPIRED", reason);
}

/**
 * Cancel an execution (e.g. user cancelled). Legal from any non-terminal
 * forward state up to (but not including) PICKED_UP — once the passenger /
 * freight is on board, the trip cannot be cancelled, only FAILED.
 */
export function cancel(
  execution: TransportationExecution,
  reason: string,
): TransportationExecution {
  return transition(execution, "CANCELLED", reason);
}

/**
 * Mark an execution as failed (e.g. vehicle broke down). Legal from any
 * non-terminal forward state.
 */
export function fail(
  execution: TransportationExecution,
  reason: string,
): TransportationExecution {
  return transition(execution, "FAILED", reason);
}

/**
 * Mark an execution as a no-show (supplier didn't show up at pickup).
 * Legal from DISPATCHED or EN_ROUTE.
 */
export function markNoShow(
  execution: TransportationExecution,
  reason: string = "Supplier did not show up at pickup.",
): TransportationExecution {
  return transition(execution, "NO_SHOW", reason);
}

/**
 * Mark an execution as unfulfilled (completed but didn't meet demand
 * constraints — e.g. delivered late, or to the wrong location). Legal only
 * from EXECUTING.
 */
export function markUnfulfilled(
  execution: TransportationExecution,
  reason: string,
): TransportationExecution {
  return transition(execution, "UNFULFILLED", reason);
}

// ═══════════════════════════════════════════════════════════════════════
// QUERIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Is this execution in a successful terminal state (COMPLETED)?
 */
export function isCompleted(execution: TransportationExecution): boolean {
  return execution.state === "COMPLETED";
}

/**
 * Is this execution in a failure terminal state?
 */
export function isFailed(execution: TransportationExecution): boolean {
  return FAILURE_STATES.includes(execution.state);
}

/**
 * What is the index of this execution's state in the forward lifecycle?
 * Returns -1 for failure states. Useful for "how far along is this trip"
 * UIs.
 */
export function lifecycleIndex(execution: TransportationExecution): number {
  return FORWARD_LIFECYCLE.indexOf(execution.state);
}

/**
 * Human-readable summary of the execution's current state, for logging /
 * UI. Includes the state, environment, and (if applicable) the W3-M/W4-M
 * evidence eligibility.
 */
export function summarize(execution: TransportationExecution): string {
  const evidence = canProduceEvidence(execution);
  const parts: string[] = [
    `Execution ${execution.id}`,
    `state=${execution.state}`,
    `env=${execution.environment}`,
  ];
  if (execution.failureReason) {
    parts.push(`reason="${execution.failureReason}"`);
  }
  parts.push(`w3m=${evidence.w3m ? "yes" : "no"}`);
  parts.push(`w4m=${evidence.w4m ? "yes" : "no"}`);
  return parts.join(" ");
}
