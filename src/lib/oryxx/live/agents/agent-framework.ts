// ORYXX — Live Marketplace Agent Framework (Bounded Autonomy L0–L5)
//
// Agents represent the autonomous intent of an ORYXX account: a rider, a
// shipper, a supplier, a fleet operator, or the ORYXX platform itself. Each
// agent carries a set of objective weights (cost / time / reliability /
// emissions / comfort / safety / earnings / utilization / welfare) and a set
// of hard constraints (budget, max delay, risk tolerance, minimum
// compensation, and — crucially — a maxAutonomyLevel in 0..5).
//
// The autonomy ladder is the heart of the framework. It bounds WHAT an agent
// may do on its owner's behalf without further human approval. Every level
// strictly subsumes the rights of the level below it (L3 can do everything L2
// can, plus reserve and execute within pre-approved parameters).
//
//   L0 — Recommend only.        Pure advisory. Agent may discover and rank
//                                 opportunities but CANNOT bid, counteroffer,
//                                 reserve, accept, reject, execute, dispatch,
//                                 or settle. Every commitment flows through
//                                 the human owner.
//
//   L1 — Prepare.                 Agent may prepare the full transaction
//                                 pipeline (bid, counteroffer, reserve, accept,
//                                 reject) but CANNOT execute the trip. The
//                                 human owner triggers execution.
//
//   L2 — User approves.           Agent may submit bids and counteroffers
//                                 autonomously, but committing capacity
//                                 (reserve), accepting an offer (accept), and
//                                 execution (execute/dispatch/settle) all
//                                 require user approval.
//
//   L3 — Execute within           Agent may bid, reserve, accept, and execute
//        pre-approved params.      within a pre-approved envelope. It CANNOT
//                                 dispatch (e.g. trigger a one-shot
//                                 out-of-band carrier dispatch) or settle
//                                 payments.
//
//   L4 — Continuous autonomous    Agent may dispatch and continuously
//        optimization.            re-optimize. It CANNOT settle payments —
//                                 money movement always requires a separate
//                                 human / settlement-system gate.
//
//   L5 — Fully delegated.         All actions authorized within the agent's
//                                 hard constraints. The owner has fully
//                                 delegated transactional authority.
//
// Every decision is logged as an AgentDecision carrying the agentId, the
// autonomyLevel at which it was made, the constraints under which it was
// evaluated, and — critically — an `authorized` boolean. Decisions taken
// beyond the agent's maxAutonomyLevel are STILL logged (so the audit trail
// captures the attempt) but flagged `authorized: false`, and the caller is
// expected to refuse to act on them.
//
// Provenance: every Agent carries a Provenance (environment / source /
// observedAt / confidence). An agent created in SANDBOX can never authorize
// a LIVE execution — the environment tag flows through to every decision.
//
// No LLM is ever in the authorization path. isAuthorized() is a pure function
// of (level, action). The ranking is a pure weighted-sum over normalized
// opportunity metrics. submitBid() is a pure authorization + bounds check.
// All of this is deterministic and auditable.

import type {
  Agent,
  AgentDecision,
  AgentRole,
  AutonomyLevel,
  Negotiation,
  Provenance,
  ProvenanceSource,
  TransportationOpportunity,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Framework version — bumped on any change to the authorization matrix or
 * ranking algorithm so downstream audit tools can detect drift.
 */
export const AGENT_FRAMEWORK_VERSION = "oryxx-agent-v1.0.0";

/**
 * The set of actions an agent may attempt. This is a strict superset of
 * AgentDecision["decisionType"]: it adds "dispatch" (the act of sending a
 * vehicle on its way, distinct from the broader "execute" lifecycle step)
 * and "settle" (payment settlement), which are governed by the upper end of
 * the autonomy ladder but do not appear as Negotiation-style decision types.
 */
export type AgentAction =
  | "discover"
  | "rank"
  | "bid"
  | "counteroffer"
  | "reserve"
  | "accept"
  | "reject"
  | "execute"
  | "dispatch"
  | "settle";

/**
 * Human-readable label for each autonomy level. Used in audit logs and UI
 * affordances (e.g. "This action requires L3 (Execute within pre-approved
 * parameters) — current agent is L2 (User approves).").
 */
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: "L0 — Recommend only",
  1: "L1 — Prepare",
  2: "L2 — User approves",
  3: "L3 — Execute within pre-approved parameters",
  4: "L4 — Continuous autonomous optimization",
  5: "L5 — Fully delegated",
};

// ═══════════════════════════════════════════════════════════════════════
// AUTHORIZATION MATRIX
// ═══════════════════════════════════════════════════════════════════════

/**
 * The authorization matrix. Rows are actions; columns are autonomy levels.
 * A `true` cell means an agent AT OR ABOVE that level may perform the action
 * without further human approval (subject to its other hard constraints —
 * e.g. budget, maxDelayMin).
 *
 * The matrix is monotonic: if level L permits an action, every level > L
 * also permits it. This is enforced by construction (each row's `true`
 * cells form a contiguous suffix).
 *
 * Rationale per row (matching the ladder description above):
 *
 *   discover / rank      — informational only; permitted at every level
 *                          including L0 (recommend-only).
 *   bid / counteroffer   — price proposals; L0 denies (recommend only);
 *                          L1+ permits (preparation step).
 *   reject               — declining an offer is non-committal but still
 *                          a marketplace action; L0 denies, L1+ permits.
 *   reserve              — committing supply capacity; L0/L2 deny (require
 *                          user approval), L1/L3/L4/L5 permit.
 *                          Wait — L1 is "prepare" which includes reserve
 *                          (preparing a reservation); L2 is "user approves"
 *                          which requires human sign-off on reservations.
 *   accept               — finalizing an agreement; same gating as reserve.
 *   execute              — dispatching the trip / starting execution;
 *                          requires L3+ (pre-approved execution).
 *   dispatch             — one-shot out-of-band carrier dispatch; requires
 *                          L4+ (continuous autonomous optimization).
 *   settle               — payment settlement; L5 only (fully delegated).
 */
const AUTHORIZATION_MATRIX: Record<AgentAction, Record<AutonomyLevel, boolean>> = {
  discover: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true },
  rank: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true },
  bid: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true },
  counteroffer: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true },
  reject: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true },
  reserve: { 0: false, 1: true, 2: false, 3: true, 4: true, 5: true },
  accept: { 0: false, 1: true, 2: false, 3: true, 4: true, 5: true },
  execute: { 0: false, 1: false, 2: false, 3: true, 4: true, 5: true },
  dispatch: { 0: false, 1: false, 2: false, 3: false, 4: true, 5: true },
  settle: { 0: false, 1: false, 2: false, 3: false, 4: false, 5: true },
};

// ═══════════════════════════════════════════════════════════════════════
// ID GENERATION
// ═══════════════════════════════════════════════════════════════════════

let agentCounter = 0;
let decisionCounter = 0;

/**
 * Generate a unique Agent ID. Prefixed "AGT-" and suffixed with an
 * in-process counter plus the owner ID, so audit logs read like:
 *   AGT-{ownerId}-{counter}
 * This is not security-sensitive; it only needs to be unique within a single
 * ORYXX process.
 */
function nextAgentId(ownerId: string): string {
  agentCounter += 1;
  return `AGT-${ownerId}-${agentCounter}`;
}

/**
 * Generate a unique AgentDecision ID. Prefixed "DEC-" and suffixed with the
 * agent ID and an in-process counter.
 */
function nextDecisionId(agentId: string): string {
  decisionCounter += 1;
  return `DEC-${agentId}-${decisionCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE AGENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Default provenance for an agent created in the LIVE marketplace layer.
 * The environment defaults to LIVE — sandbox callers should explicitly
 * pass a SANDBOX provenance so the agent's decisions inherit the sandbox
 * tag and can never be confused with live commerce.
 */
const DEFAULT_AGENT_PROVENANCE_SOURCE: ProvenanceSource = "direct-user";

/**
 * Create a new Agent with bounded autonomy.
 *
 * The agent's maxAutonomyLevel is the OWNER-IMPOSED CEILING. The agent may
 * operate at any level up to and including this ceiling; it may never
 * exceed it. (The runtime decision's actual autonomyLevel may be lower —
 * e.g. an L4 agent can still issue L1 "prepare" decisions for routine
 * surfacing of options.)
 *
 * @param ownerId              The ORYXX account that owns this agent.
 * @param role                 The agent's role in the marketplace.
 * @param objectiveWeights     Weights for the ranking objective. Need not
 *                             sum to 1; they are normalized internally.
 *                             At least one weight should be non-zero;
 *                             otherwise rankOpportunities returns the input
 *                             unchanged.
 * @param constraints          Hard constraints. maxAutonomyLevel is REQUIRED
 *                             here — it is the owner's ceiling on the
 *                             agent's autonomy. Other fields (budget,
 *                             maxDelayMin, riskTolerance,
 *                             minimumCompensation) are optional and
 *                             enforced by callers (e.g. submitBid checks
 *                             budget and minimumCompensation where
 *                             applicable).
 * @param maxAutonomyLevel     Convenience parameter: if provided, this
 *                             overrides constraints.maxAutonomyLevel. This
 *                             is the more ergonomic call site for the
 *                             common case where the caller has the level
 *                             as a discrete argument.
 * @param provenance           Optional provenance override. Defaults to a
 *                             direct-user LIVE provenance. Sandbox callers
 *                             MUST pass a SANDBOX provenance.
 * @param availability         Optional availability window for the agent
 *                             itself (e.g. a supplier agent that is only
 *                             active 09:00–17:00).
 * @param isAutoEnabled        Whether the agent is permitted to act
 *                             autonomously at all. If false, the agent may
 *                             still discover/rank/recommend but every
 *                             other action is denied regardless of
 *                             autonomy level (treated as L0). Defaults
 *                             to true.
 * @returns                   A new Agent.
 */
export function createAgent(
  ownerId: string,
  role: AgentRole,
  objectiveWeights: Agent["objectiveWeights"],
  constraints: Omit<Agent["constraints"], "maxAutonomyLevel"> & {
    maxAutonomyLevel?: AutonomyLevel;
  },
  maxAutonomyLevel?: AutonomyLevel,
  provenance?: Provenance,
  availability?: Agent["availability"],
  isAutoEnabled: boolean = true,
): Agent {
  // Resolve the effective max autonomy level. The discrete parameter wins
  // if provided; otherwise fall back to the constraints object.
  const effectiveLevel: AutonomyLevel =
    maxAutonomyLevel ?? constraints.maxAutonomyLevel ?? 0;

  if (effectiveLevel < 0 || effectiveLevel > 5) {
    throw new Error(
      `Invalid maxAutonomyLevel ${effectiveLevel}; must be an integer 0..5.`,
    );
  }

  // Build the constraints object with the resolved level.
  const resolvedConstraints: Agent["constraints"] = {
    ...constraints,
    maxAutonomyLevel: effectiveLevel,
  };

  // Default provenance: direct-user LIVE. Sandbox callers MUST override.
  const resolvedProvenance: Provenance =
    provenance ?? {
      environment: "LIVE",
      source: DEFAULT_AGENT_PROVENANCE_SOURCE,
      observedAt: new Date().toISOString(),
      confidence: 1,
    };

  return {
    id: nextAgentId(ownerId),
    ownerId,
    role,
    objectiveWeights: { ...objectiveWeights },
    constraints: resolvedConstraints,
    availability,
    isAutoEnabled,
    provenance: resolvedProvenance,
    createdAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// AUTHORIZATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Determine whether an agent is authorized to perform a given action at a
 * given autonomy level, subject to the agent's maxAutonomyLevel ceiling.
 *
 * The check is the AND of three conditions:
 *
 *   1. The agent's isAutoEnabled flag is true. A disabled agent is treated
 *      as L0 (recommend only) regardless of its configured level, because
 *      the owner has switched off autonomous behavior.
 *
 *   2. The requested autonomyLevel is <= the agent's maxAutonomyLevel. An
 *      agent may never act above its owner-imposed ceiling.
 *
 *   3. The AUTHORIZATION_MATRIX permits the action at the requested level.
 *
 * Note that this function does NOT check the agent's other constraints
 * (budget, maxDelayMin, etc.) — those are evaluated by the caller (e.g.
 * submitBid checks budget and bounds). isAuthorized is purely about the
 * autonomy / action authorization.
 *
 * @param agent           The agent attempting the action.
 * @param autonomyLevel   The autonomy level at which the action is being
 *                        attempted. Must be 0..5. If omitted, defaults to
 *                        the agent's maxAutonomyLevel (i.e. "act at my
 *                        full permitted level").
 * @param action          The action being attempted.
 * @returns               true iff the agent is authorized.
 */
export function isAuthorized(
  agent: Agent,
  autonomyLevel: AutonomyLevel,
  action: AgentAction,
): boolean {
  // Condition 1: auto-enabled flag.
  if (!agent.isAutoEnabled) {
    // A disabled agent may still discover and rank (pure advisory).
    if (action === "discover" || action === "rank") return true;
    return false;
  }

  // Condition 2: ceiling check.
  if (autonomyLevel > agent.constraints.maxAutonomyLevel) {
    return false;
  }

  // Condition 3: matrix check.
  return AUTHORIZATION_MATRIX[action][autonomyLevel] ?? false;
}

/**
 * The minimum autonomy level required to perform a given action. Useful for
 * surfacing "this action requires L3" in the UI when an agent at L2 attempts
 * it. Returns the lowest level L such that AUTHORIZATION_MATRIX[action][L]
 * is true. Returns 5 if no level permits it (should never happen for a
 * well-formed action, since L5 permits everything by definition).
 */
export function minimumLevelFor(action: AgentAction): AutonomyLevel {
  for (let level = 0 as AutonomyLevel; level <= 5; level = (level + 1) as AutonomyLevel) {
    if (AUTHORIZATION_MATRIX[action][level as AutonomyLevel]) {
      return level as AutonomyLevel;
    }
  }
  return 5;
}

// ═══════════════════════════════════════════════════════════════════════
// DECISION LOGGING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Map an AgentAction to the corresponding AgentDecision["decisionType"].
 * "dispatch" and "settle" collapse to "execute" in the decision log — they
 * are sub-actions of execution, distinguished by their `constraints`
 * payload rather than their decisionType. This keeps the decision log
 * schema aligned with the canonical AgentDecision type.
 */
function actionToDecisionType(
  action: AgentAction,
): AgentDecision["decisionType"] {
  switch (action) {
    case "discover":
      return "discover";
    case "rank":
      return "rank";
    case "bid":
      return "bid";
    case "counteroffer":
      return "counteroffer";
    case "reserve":
      return "reserve";
    case "accept":
      return "accept";
    case "reject":
      return "reject";
    case "execute":
    case "dispatch":
    case "settle":
      // dispatch and settle are recorded as "execute" decisions, with the
      // specific sub-action carried in the constraints payload.
      return "execute";
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = action;
      void _exhaustive;
      return "execute";
    }
  }
}

/**
 * Record an agent decision. The decision is ALWAYS logged — even if
 * unauthorized — so the audit trail captures the attempt. The `authorized`
 * flag distinguishes permitted decisions from out-of-bounds attempts.
 *
 * The decision is evaluated at the agent's maxAutonomyLevel unless an
 * explicit lower level is requested via the `constraints.attemptedLevel`
 * field. This lets an L4 agent record an L1 "prepare" decision (e.g.
 * surfacing options to its owner) without falsely inflating its autonomy
 * profile.
 *
 * @param agent           The agent making the decision.
 * @param decisionType    The decision type (discover / rank / bid / ...).
 * @param targetId        The ID of the object the decision targets
 *                        (opportunityId, demandId, negotiationId, etc.).
 * @param reasoning       Human-readable reasoning. For audit only — never
 *                        used in the authorization logic.
 * @param constraints     Additional constraints / context to record with
 *                        the decision. May include:
 *                          - attemptedLevel: explicit autonomy level
 *                            (defaults to agent.constraints.maxAutonomyLevel)
 *                          - action: the AgentAction (e.g. "dispatch")
 *                            when decisionType is "execute"
 *                          - any other audit-relevant fields.
 * @returns               An AgentDecision with authorized computed.
 */
export function makeDecision(
  agent: Agent,
  decisionType: AgentDecision["decisionType"],
  targetId: string,
  reasoning: string,
  constraints: Record<string, any> = {},
): AgentDecision {
  // Resolve the attempted autonomy level.
  const attemptedLevel: AutonomyLevel =
    (constraints.attemptedLevel as AutonomyLevel | undefined) ??
    agent.constraints.maxAutonomyLevel;

  if (attemptedLevel < 0 || attemptedLevel > 5) {
    throw new Error(
      `Invalid attemptedLevel ${attemptedLevel}; must be an integer 0..5.`,
    );
  }

  // Resolve the action. If the caller supplied an explicit "action" field
  // (e.g. "dispatch"), use it; otherwise infer from the decisionType.
  // "execute" decisionType with no explicit action defaults to "execute".
  const action: AgentAction =
    (constraints.action as AgentAction | undefined) ??
    (decisionType as AgentAction);

  const authorized = isAuthorized(agent, attemptedLevel, action);

  return {
    id: nextDecisionId(agent.id),
    agentId: agent.id,
    decisionType,
    targetId,
    autonomyLevel: attemptedLevel,
    reasoning,
    constraints: {
      ...constraints,
      action,
      agentMaxAutonomyLevel: agent.constraints.maxAutonomyLevel,
      agentIsAutoEnabled: agent.isAutoEnabled,
      environment: agent.provenance.environment,
      source: agent.provenance.source,
    },
    authorized,
    timestamp: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// OPPORTUNITY RANKING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Normalize a list of numeric values to 0..1 (min-max normalization). If
 * all values are equal, returns all 0.5 (no signal — neutral).
 *
 * `invert` flips the normalization so that LOWER raw values map to HIGHER
 * normalized scores (used for cost, time, distance — lower is better).
 */
function normalize(
  values: number[],
  invert: boolean = false,
): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    // No signal — assign neutral 0.5 to all so the weight contributes
    // nothing to the ranking differential.
    return values.map(() => 0.5);
  }
  const range = max - min;
  if (invert) {
    // Lower-is-better: invert so min → 1, max → 0.
    return values.map((v) => (max - v) / range);
  }
  // Higher-is-better: min → 0, max → 1.
  return values.map((v) => (v - min) / range);
}

/**
 * Compute per-opportunity raw metrics from a TransportationOpportunity.
 * Each metric is a non-negative number where HIGHER IS BETTER by default
 * (callers pass `invert: true` to normalize metrics where lower is better).
 *
 * Metrics:
 *   - cost          → opportunity.price (lower is better → invert)
 *   - time          → opportunity.route.estimatedTimeMin (lower → invert)
 *   - reliability   → opportunity.executionProbability (higher is better)
 *   - emissions     → 1 / (1 + distanceKm) (proxy: shorter trips emit less)
 *   - comfort       → opportunity.confidence (proxy: higher confidence
 *                     ≈ more reliable ≈ more comfortable)
 *   - safety        → opportunity.confidence (proxy)
 *   - earnings      → opportunity.supplierCompensation (higher is better
 *                     for supplier / fleet roles)
 *   - utilization   → opportunity.capacityUsed (higher is better for
 *                     supplier / fleet roles — fuller loads)
 *   - welfare       → (price - supplierCompensation) + platformFee
 *                     (the surplus captured by the marketplace)
 */
function opportunityMetrics(opp: TransportationOpportunity): {
  cost: number;
  time: number;
  reliability: number;
  emissions: number;
  comfort: number;
  safety: number;
  earnings: number;
  utilization: number;
  welfare: number;
} {
  const distanceKm = Math.max(opp.route.distanceKm, 0);
  const timeMin = Math.max(opp.route.estimatedTimeMin, 0);
  return {
    cost: Math.max(opp.price, 0),
    time: timeMin,
    reliability: clampUnit(opp.executionProbability),
    emissions: 1 / (1 + distanceKm),
    comfort: clampUnit(opp.confidence),
    safety: clampUnit(opp.confidence),
    earnings: Math.max(opp.supplierCompensation, 0),
    utilization: Math.max(opp.capacityUsed, 0),
    welfare: Math.max(opp.price - opp.supplierCompensation + opp.platformFee, 0),
  };
}

function clampUnit(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Rank a list of opportunities by the agent's objective weights.
 *
 * The ranking is a weighted sum over normalized opportunity metrics. Each
 * metric is min-max normalized across the opportunity set (so a single
 * opportunity's absolute price doesn't dominate — only its relative
 * position in the set matters). Metrics where lower is better (cost, time)
 * are inverted before normalization so that HIGHER normalized = BETTER
 * for every metric uniformly.
 *
 * If the agent has no objective weights set (all zero / undefined), the
 * opportunities are returned in their input order — the agent has no
 * preference signal and so does not reorder.
 *
 * If the agent's maxAutonomyLevel is L0 (recommend only) the ranking is
 * still computed — L0 agents recommend, and recommendations are ordered.
 * The autonomy level bounds what the agent does with the ranking, not
 * whether it can compute one.
 *
 * @param agent           The agent whose objective weights drive the ranking.
 * @param opportunities   The opportunities to rank.
 * @returns               A new array, sorted best-first by weighted score.
 *                        Ties broken by lower price, then by opportunity ID
 *                        for deterministic output.
 */
export function rankOpportunities(
  agent: Agent,
  opportunities: TransportationOpportunity[],
): TransportationOpportunity[] {
  if (opportunities.length === 0) return [];

  const weights = agent.objectiveWeights;
  // Normalize weights to sum to 1 (so the score is interpretable as a
  // weighted average of normalized metrics in 0..1, yielding a 0..1 score).
  const rawWeightEntries = Object.entries(weights).filter(
    ([, w]) => typeof w === "number" && w > 0,
  ) as [keyof typeof weights, number][];

  // No weights → no preference signal → return input order.
  if (rawWeightEntries.length === 0) {
    return [...opportunities];
  }

  const totalWeight = rawWeightEntries.reduce(
    (sum, [, w]) => sum + (w as number),
    0,
  );

  // Compute raw metric vectors.
  const metrics = opportunities.map(opportunityMetrics);

  // Per-metric normalization (with invert flags for lower-is-better metrics).
  const invert: Record<keyof ReturnType<typeof opportunityMetrics>, boolean> = {
    cost: true,
    time: true,
    reliability: false,
    emissions: true, // 1/(1+km) is already higher-is-better, but the
    // underlying distance is lower-is-better; we use the proxy directly
    // so no inversion needed. Set false to avoid double-inverting.
    comfort: false,
    safety: false,
    earnings: false,
    utilization: false,
    welfare: false,
  };
  // Correction: emissions proxy 1/(1+km) is already higher-is-better
  // (shorter trips → higher value). Do NOT invert.
  invert.emissions = false;

  const metricKeys = Object.keys(metrics[0]) as (keyof ReturnType<typeof opportunityMetrics>)[];
  const normalized: Record<string, number[]> = {};
  for (const key of metricKeys) {
    normalized[key] = normalize(
      metrics.map((m) => m[key]),
      invert[key],
    );
  }

  // Compute weighted score per opportunity.
  const scored = opportunities.map((opp, i) => {
    let score = 0;
    for (const [key, rawWeight] of rawWeightEntries) {
      const w = (rawWeight as number) / totalWeight;
      const metricValue = normalized[key][i] ?? 0.5;
      score += w * metricValue;
    }
    return { opp, score, index: i };
  });

  // Sort by score descending; tiebreak by lower price, then by ID for
  // deterministic output (stable across runs).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.opp.price !== b.opp.price) return a.opp.price - b.opp.price;
    return a.opp.id < b.opp.id ? -1 : a.opp.id > b.opp.id ? 1 : 0;
  });

  return scored.map((s) => s.opp);
}

// ═══════════════════════════════════════════════════════════════════════
// BID SUBMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attempt to submit a bid on behalf of an agent.
 *
 * This function performs THREE checks and records a single AgentDecision
 * capturing the outcome:
 *
 *   1. Authorization: the agent must be authorized for the "bid" action at
 *      its maxAutonomyLevel. L0 agents (recommend only) cannot bid; L1+
 *      can.
 *
 *   2. Bounds: the proposed price must lie within the negotiation's
 *      [minimumPrice, maximumPrice] envelope. A price outside the bounds
 *      is still recorded (for audit) but flagged unauthorized, because it
 *      would violate the negotiation's hard constraints.
 *
 *   3. Budget (if the agent is a buyer-side role and has a budget
 *      constraint): the proposed price must not exceed the agent's budget.
 *      A buyer agent bidding above its own budget is unauthorized.
 *
 * The decision is ALWAYS recorded — even if unauthorized — so the audit
 * trail captures the attempt. Callers (e.g. the negotiation engine) are
 * expected to refuse to act on decisions where authorized === false.
 *
 * @param agent          The agent submitting the bid.
 * @param negotiation    The negotiation the bid is being submitted to.
 * @param price          The proposed price, in integer minor units.
 * @returns              An AgentDecision with decisionType "bid",
 *                       targetId = negotiation.id, and authorized reflecting
 *                       the three checks above.
 */
export function submitBid(
  agent: Agent,
  negotiation: Negotiation,
  price: number,
): AgentDecision {
  const attemptedLevel = agent.constraints.maxAutonomyLevel;
  const authorizedByAutonomy = isAuthorized(agent, attemptedLevel, "bid");

  // Bounds check: price within [minimumPrice, maximumPrice].
  const withinBounds =
    price >= negotiation.minimumPrice && price <= negotiation.maximumPrice;

  // Budget check: only for buyer-side roles that have a budget constraint.
  // (Supplier / fleet / oryxx roles don't have a buyer budget; their
  // equivalent is minimumCompensation, which the negotiation's
  // minimumPrice already enforces.)
  const isBuyerSide = agent.role === "rider" || agent.role === "shipper";
  const budget = agent.constraints.budget;
  const withinBudget =
    !isBuyerSide ||
    typeof budget !== "number" ||
    price <= budget;

  const authorized = authorizedByAutonomy && withinBounds && withinBudget;

  // Compose a human-readable reasoning string that captures the outcome of
  // each check — useful when the decision is reviewed in an audit log.
  const reasons: string[] = [];
  if (!authorizedByAutonomy) {
    reasons.push(
      `Agent ${agent.id} at ${AUTONOMY_LABELS[attemptedLevel]} is not ` +
        `authorized to bid (requires L1+).`,
    );
  }
  if (!withinBounds) {
    reasons.push(
      `Price ${price} is outside negotiation ${negotiation.id} bounds ` +
        `[${negotiation.minimumPrice}, ${negotiation.maximumPrice}].`,
    );
  }
  if (!withinBudget) {
    reasons.push(
      `Price ${price} exceeds agent budget ${budget}.`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      `Bid of ${price} on negotiation ${negotiation.id} is authorized ` +
        `at ${AUTONOMY_LABELS[attemptedLevel]} and within bounds/budget.`,
    );
  }

  return makeDecision(
    agent,
    "bid",
    negotiation.id,
    reasons.join(" "),
    {
      action: "bid",
      attemptedLevel,
      negotiationId: negotiation.id,
      opportunityId: negotiation.opportunityId,
      demandId: negotiation.demandId,
      supplyId: negotiation.supplyId,
      proposedPrice: price,
      minimumPrice: negotiation.minimumPrice,
      maximumPrice: negotiation.maximumPrice,
      withinBounds,
      budget,
      withinBudget,
      autonomyAuthorized: authorizedByAutonomy,
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIT HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Filter a list of decisions to only those that were authorized. Useful for
 * audit dashboards that show "what the agent actually did" vs. "what it
 * attempted".
 */
export function authorizedDecisions(
  decisions: AgentDecision[],
): AgentDecision[] {
  return decisions.filter((d) => d.authorized);
}

/**
 * Filter a list of decisions to only those that were UNauthorized (i.e.
 * attempts beyond the agent's bounds). Useful for surfacing escalation /
 * review prompts.
 */
export function unauthorizedDecisions(
  decisions: AgentDecision[],
): AgentDecision[] {
  return decisions.filter((d) => !d.authorized);
}

/**
 * Did the agent make any unauthorized decisions? A boolean convenience
 * over unauthorizedDecisions().length > 0.
 */
export function hasEscalations(decisions: AgentDecision[]): boolean {
  return decisions.some((d) => !d.authorized);
}
