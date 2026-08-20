# ORYXX W3-R Pilot Protocol

**Status**: FROZEN — corresponds exactly to the preregistered design encoded in `src/lib/oryxx/real/evidence/pilot.ts` and `prisma/schema.prisma`.

**Document version**: 1.0
**Last updated**: 2026-08-20
**Preregistration hash source**: `computePreregistrationHash(PreregisteredDesign)` — full SHA-256 of the canonical JSON design, stored on `AcceptanceExperiment.preregistrationHash`.

---

## A. Hypothesis

> Providers will accept pooled-trip offers when compensation ≥ $3 and detour ≤ 2 km.

This is the exact hypothesis string persisted on `AcceptanceExperiment.hypothesis` at experiment creation. It is **not** a marketplace liquidity claim. It is a behavioral acceptance claim under controlled research conditions.

---

## B. Primary Outcome

**W3-R acceptance rate** — the proportion of viewed research offers that the provider ACCEPTS.

- Outcome key: `W3_acceptance_rate` (stored on `AcceptanceExperiment.primaryOutcome`)
- Numerator: responses with `evidenceTier = "W3-R"` (state `PROVIDER_ACCEPTED`)
- Denominator: responses with `state ∈ {PROVIDER_VIEWED, PROVIDER_ACCEPTED, PROVIDER_DECLINED, PROVIDER_UNAVAILABLE, PROVIDER_IGNORED}` (i.e. viewed offers)

---

## C. Secondary Outcomes

1. **W4-R completion rate** — proportion of accepted offers that reach `TRIP_COMPLETED`
2. **Net value** — `assumedUserSavings − assumedFailureCost` per accepted offer (economic assumption, not observed revenue)

Stored on `AcceptanceExperiment.secondaryOutcomes` as `["W4-R_completion_rate", "net_value"]`.

---

## D. Population

- **Population**: ride-hail / taxi / FHV drivers
- **Geography**: NYC (or pilot geography declared at preregistration)
- **Provider type**: taxi / FHV (stored on `AcceptanceExperiment.providerType`)

---

## E. Inclusion Criteria

A participant may be enrolled only if ALL of the following hold:

1. Holds an authenticated ORYXX account (`session.user.email` is non-null)
2. Has not previously enrolled in the same experiment (enforced by `@@unique([experimentId, accountEmail])`)
3. Is operator-verified as a real transportation provider (`providerVerified = "operator_verified"`) before any offer is presented

---

## F. Exclusion Criteria

A participant is excluded if ANY of the following hold:

1. `providerVerified = "unverified"` — no offers may be created
2. `providerVerified = "externally_verified"` — structurally impossible in the current pilot (the API rejects this; only `operator_verified` is permitted)
3. Account is suspended (`User.status = "suspended"`)
4. Enrollment status is `withdrawn` — no new offers or transitions accepted
5. The experiment is not `ACTIVE` — no enrollments, offers, or transitions accepted

---

## G. Recruitment Method

Operators recruit real transportation providers through direct outreach (e.g. fleet partnerships, driver cooperative outreach). Each recruited provider receives an invitation; the operator creates an ORYXX account for them via the waitlist → admin-approve flow (`/api/waitlist`, admin approval).

The operator then performs **operator verification** (see section 7) and only then enrolls the provider into the preregistered experiment.

**Recruitment source is logged** in the bias log (section 19) because it is a known confound.

---

## H. Consent Process

Consent is **mandatory** before any offer is presented. The flow:

1. After enrollment, the provider's dashboard shows the consent text (stored on `AcceptanceExperiment.consentText`, version on `consentVersion`).
2. The provider explicitly agrees. The API records consent in `ExperimentConsent` with:
   - `accountEmail` (bound to the authenticated account, NOT the enrollment token — prevents cross-user consent)
   - `consentTextHash` (SHA-256 of the consent text — proves which version was agreed to)
   - `consentVersion`
   - `consentedAt` timestamp
3. Offer creation (`mode: "create_offer"`) refuses to proceed unless a valid, non-withdrawn consent exists.

**Consent text may not be modified after the experiment is ACTIVE.** A new consent version requires a new experiment with a new preregistration hash.

**Withdrawal of consent** is supported via `mode: "withdraw"` — idempotent, account-bound, preserves historical data.

---

## I. Experiment Duration

- **Target sample**: 100 responses (stored on `AcceptanceExperiment.sampleTarget`)
- **Stopping rule**: "Stop after 100 responses or 30 days." (stored on `AcceptanceExperiment.stoppingRule`)
- The experiment moves to `COMPLETED` only after the stopping rule is satisfied (see section 17).

---

## J. Treatment Assignment

Treatment cells are generated from the preregistered design:

- `compensationBuckets`: `[1, 2, 3, 4, 5]` (USD)
- `detourBuckets`: `[0, 0.5, 1, 2, 3]` (km)
- `extraTimeBuckets`: `[0, 2, 5, 10]` (minutes)
- `noticeBuckets`: `[0, 15, 60]` (minutes advance notice)

Cells are filtered by safety constraints (`maxDetourKm`, `maxExtraTimeMin`, `minCompensation`). The full cross-product produces the preregistered cell set. Each cell has an ID of the form `cell-{comp}-{detour}-{time}-{notice}`.

**Assignment algorithm**: least-filled allocation with deterministic tiebreak (seeded by `participantId + experimentId + randomizationSeed`). The function `assignTreatment()` in `src/lib/oryxx/real/evidence/pilot.ts` is the sole source of treatment assignment. **No operator may choose a treatment cell manually.**

---

## K. Offer Presentation

Offers are created via `mode: "create_offer"`. The handler:

1. Loads the persisted design via `loadDesignStrict(exp.treatmentDesignJson)` — throws on missing
2. Verifies the preregistration hash via `verifyDesignHash(design, exp.preregistrationHash)` — throws on mismatch
3. Resolves the participant's assigned cell (immutable after enrollment)
4. Validates offer safety via `validateOfferSafety()` against `maxDetourKm`, `maxExtraTimeMin`, `minCompensation`
5. Creates a `ProviderResponse` with state `OFFER_CREATED`
6. Sets `offerExpiresAt` = now + 30 minutes (stored explicitly, not computed from presentedAt)
7. Appends a hash-chained `OFFER_CREATED` audit event

The offer is **immutable** after `OFFER_PRESENTED`. No operator may alter price, detour, time, or notice after assignment.

---

## L. Accept / Decline Procedure

The provider interacts with the offer through the research UI. State transitions (validated by `isValidResearchTransition`):

```
OFFER_CREATED → OFFER_PRESENTED → PROVIDER_VIEWED
  → PROVIDER_ACCEPTED  (W3-R evidence created)
  | PROVIDER_DECLINED
  | PROVIDER_UNAVAILABLE
  | PROVIDER_IGNORED   (auto-transition on expiry)

PROVIDER_ACCEPTED → TRIP_STARTED → TRIP_COMPLETED (W4-R) | TRIP_CANCELLED
```

Transitions are atomic (state mutation + audit event in the same Serializable transaction). The enrollment status is re-checked INSIDE the transaction to prevent the withdrawal-vs-transition race.

**Offer expiry**: if `offerExpiresAt` has passed and the provider attempts to accept, the offer atomically transitions to `PROVIDER_IGNORED` with an audit event. No W3-R is created.

---

## M. Withdrawal Procedure

The provider may withdraw at any time via `mode: "withdraw"`:

1. Account-bound: `enrollment.accountEmail` must match `session.user.email` — cross-user withdrawal is rejected (403)
2. Idempotent: if already withdrawn, returns the existing `withdrawnAt`
3. Blocks all future transitions: the transition handler re-checks `enrollment.status` INSIDE its Serializable transaction
4. **Historical data is preserved** — W3-R evidence already recorded is NOT erased (it remains part of the experiment record)
5. Consents are marked `withdrawnAt` (but retained for audit)

---

## N. Safety Limits

Stored on the experiment and enforced at offer creation:

- `maxDetourKm`: 5.0 km (default)
- `maxExtraTimeMin`: 20.0 minutes (default)
- `minCompensation`: $1.00 (default)
- `passengerCount`: capped at 3 (hardcoded in `validateOfferSafety`)
- `offerExpiresAt`: 30 minutes after creation

Any offer violating these limits is rejected with HTTP 400 and a list of violations.

---

## O. Compensation

Compensation values come **only** from the preregistered `compensationBuckets`. The provider sees the compensation in the offer UI. Compensation is a research stimulus — it is **not** a marketplace payment. No wallet, no payout, no billing. The `assumedUserSavings`, `assumedFailureCost`, and `assumedOryxxMargin` are economic assumptions for analysis, not observed cash flows.

---

## P. Data Collection

Per response, the following are collected (no PII beyond the account email, which is bound to the pseudonymous `participantId`):

- `participantId` (server-generated, pseudonymous)
- `treatmentCellId`, `compensation`, `detourKm`, `extraTimeMin`, `advanceNoticeMin`, `passengerCount`
- `tripDistanceKm`, `originName`, `destName`, `hourOfDay`
- `state`, `decision`, `evidenceTier`
- Timestamps: `offerPresentedAt`, `providerViewedAt`, `decisionAt`, `offerExpiresAt`
- Execution: `executed`, `completed`, `executionFailureReason`
- Verification: `externalVerificationMethod`, `externalVerifiedBy`, `externalVerifiedAt`, `completionEvidenceLevel`

**Audit events** (`ExperimentEvent`) form a hash-chained, append-only trail. No UPDATE or DELETE endpoint exists.

---

## Q. Data Retention

- Experiment data (enrollments, responses, consents, events) is retained indefinitely for research integrity.
- Withdrawn participants' data is NOT deleted — it is preserved for audit and analysis.
- The event log is append-only — no modification or deletion is possible via the API.
- PII is limited to `accountEmail` (bound to the pseudonymous `participantId`). No names, phone numbers, or vehicle plates are stored.

---

## R. Stopping Rule

> "Stop after 100 responses or 30 days."

The experiment must not move to `COMPLETED` until this rule is satisfied. The stop gate (section 17) verifies this before allowing the transition.

---

## S. Analysis Plan

See `docs/research/w3-r-analysis-plan.md` for the full preregistered analysis plan. Summary:

- **Primary**: W3-R acceptance rate per treatment cell, Wilson 95% CI
- **Secondary**: W4-R completion rate per cell, Wilson 95% CI
- **Comparisons**: across compensation, detour, extra time, and notice dimensions
- **No post-hoc** changes to the primary outcome, no cherry-picking cells, no changing the stopping rule after observing results.

---

## T. Bias and Limitations

See `docs/research/w3-r-bias-log.md` for the living bias log. Known confounds:

- **Selection bias**: recruited providers may not represent the general driver population
- **Professional-driver bias**: recruited providers may be more experienced/cooperative than average
- **Geography**: pilot is limited to NYC (or declared pilot geography)
- **Time-of-day**: offers are presented at varying times; acceptance may correlate with demand
- **Provider type**: taxi vs FHV may differ systematically
- **Recruitment source**: fleet partnership vs cooperative outreach may select different populations
- **Attrition**: providers may withdraw mid-study
- **Nonresponse**: providers who view but do not decide are tracked as `PROVIDER_IGNORED` after expiry
- **Operator effects**: the operator who verifies providers may influence behavior

---

## U. Incident Handling

### Integrity violations

If the real-time integrity monitor (section 12) detects any of:

- offer without consent
- unverified provider receiving an offer
- withdrawn participant receiving an offer
- treatment cell change
- expired offer accepted
- W3-R without required event sequence
- W4-R without W3-R
- unexpected W3-M or W4-M

The operator must **immediately pause** the experiment (section 13: `ACTIVE → PAUSED`) and investigate. The incident is recorded in the bias log.

### Emergency stop

Any admin may pause the experiment. While `PAUSED`:
- No new enrollments
- No new offers
- No new transitions
- Historical records remain intact

Resume requires re-running the activation gate (section 16).
