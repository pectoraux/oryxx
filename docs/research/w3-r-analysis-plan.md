# ORYXX W3-R Analysis Plan

**Status**: PREREGISTERED — may not be modified after the experiment is ACTIVE.

**Experiment**: W3-R Acceptance Pilot
**Preregistration source**: `AcceptanceExperiment.preregistrationHash` (SHA-256 of canonical design JSON)

---

## 1. Primary Outcome

**W3-R acceptance rate** — the proportion of viewed research offers that the provider ACCEPTS.

- **Numerator**: responses with `evidenceTier = "W3-R"` (state `PROVIDER_ACCEPTED`)
- **Denominator**: responses with `state ∈ {PROVIDER_VIEWED, PROVIDER_ACCEPTED, PROVIDER_DECLINED, PROVIDER_UNAVAILABLE, PROVIDER_IGNORED}` (all viewed offers, including those that expired/ignored)
- **Estimand**: per-cell acceptance probability

**No post-hoc change of the primary outcome is permitted.**

---

## 2. Secondary Outcomes

1. **W4-R completion rate** — proportion of accepted offers that reach `TRIP_COMPLETED`
   - Numerator: `state = "TRIP_COMPLETED"`
   - Denominator: `state ∈ {PROVIDER_ACCEPTED, TRIP_STARTED, TRIP_COMPLETED, TRIP_CANCELLED}`
2. **Net value** — `assumedUserSavings − assumedFailureCost` per accepted offer (economic assumption, not observed revenue)

---

## 3. Treatment Comparisons

Treatment cells are the full cross-product of:

| Dimension | Buckets |
|---|---|
| Compensation (USD) | 1, 2, 3, 4, 5 |
| Detour (km) | 0, 0.5, 1, 2, 3 |
| Extra time (min) | 0, 2, 5, 10 |
| Advance notice (min) | 0, 15, 60 |

Cells violating safety constraints (`detour > maxDetourKm`, `time > maxExtraTimeMin`, `comp < minCompensation`) are excluded.

### Comparisons

- **Compensation effect**: acceptance rate as a function of compensation, holding other dimensions at their modal value (or marginal aggregation)
- **Detour effect**: acceptance rate as a function of detour distance
- **Extra-time effect**: acceptance rate as a function of additional time
- **Notice effect**: acceptance rate as a function of advance notice

---

## 4. Confidence Interval Method

**Wilson score interval** (95%), computed by `wilsonCI(accepts, total)` in `src/lib/oryxx/real/evidence/pilot.ts`.

The Wilson interval is preferred over the normal approximation for small samples and extreme proportions (near 0 or 1), which are expected in this pilot.

---

## 5. Sample Size

- **Target**: 100 responses (stored on `AcceptanceExperiment.sampleTarget`)
- **Minimum per cell for marketplace decision**: 30 (used by `evaluateMarketplaceDecision`)
- Cells with fewer than 30 observations are reported but flagged as underpowered

---

## 6. Stopping Rule

> "Stop after 100 responses or 30 days."

The experiment must not move to `COMPLETED` until:
- 100 responses are collected, OR
- 30 days have elapsed since activation

**The stopping rule may NOT be changed after observing results.**

---

## 7. Analysis Dataset

Exported via `mode: "export_analysis"` (operator-only). Contains:

- `experimentId`, `experimentVersion`, `preregistrationHash`
- `participantPseudonym` (truncated `participantId`, no email)
- `providerVerificationLevel` (`operator_verified`)
- `treatmentCellId`, `compensation`, `detourKm`, `extraTimeMin`, `advanceNoticeMin`
- `offerPresentedAt`, `providerViewedAt`, `decisionAt`, `offerExpiresAt`
- `state`, `decision`, `evidenceTier`
- `w3rTimestamp`, `w4rTimestamp`
- `completionEvidenceLevel`
- `withdrawalStatus`

**The analysis export fails closed if integrity violations are detected** (see section 9).

---

## 8. Audit Dataset

Exported via `mode: "export_audit"` (operator-only). Contains the full hash-chained event log:

- `experimentId`, `offerId`, `participantPseudonym`
- `fromState`, `toState`, `timestamp`
- `actorType`, `actorId`
- `eventHash`, `previousEventHash` (for chain verification)

The audit dataset is kept separate from the analysis dataset to prevent analysis-time modification of the evidence trail.

---

## 9. Data Quality Checks (pre-analysis)

The analysis export runs the following checks and **fails closed** if any are detected:

- Duplicate participant (same `accountEmail` enrolled twice in the same experiment)
- Duplicate offer (same `participantId` + `treatmentCellId` + `offerPresentedAt`)
- Missing treatment cell (`assignedCellId` is null)
- Missing consent (offer created without a valid, non-withdrawn consent)
- Missing provider verification (offer created to an `unverified` provider)
- Invalid state transition (transition not in `RESEARCH_TRANSITIONS`)
- Offer after withdrawal (offer created to a `withdrawn` enrollment)
- Accept after expiry (`PROVIDER_ACCEPTED` when `offerExpiresAt` has passed)
- W4-R without W3-R (`TRIP_COMPLETED` without prior `PROVIDER_ACCEPTED`)
- Unknown treatment cell (`treatmentCellId` not in `generateTreatmentCells(design)`)
- Modified preregistration hash (`verifyDesignHash` fails)

If ANY check fails, the export returns HTTP 400 with a list of violations. **No analysis dataset is produced.**

---

## 10. Reporting

Results are reported as:

- Per-cell table: `n`, `accepted`, `acceptanceRate`, `acceptanceCI95` (Wilson)
- Per-cell completion: `completed`, `completionRate`, `completionCI95` (Wilson)
- Marginal effects across each treatment dimension
- The preregistration hash is published alongside results

**Scenario-model curves are NOT reported as empirical results.** They are labeled "SCENARIO MODEL — NOT OBSERVED" and kept separate.

---

## 11. No Cherry-Picking

- All treatment cells in the preregistered design are reported, including those with zero observations.
- No cell is excluded post-hoc.
- No outlier is removed unless an integrity violation is detected (in which case the entire export fails closed).

---

## 12. Marketplace Decision (post-hoc only)

`evaluateMarketplaceDecision(cellResults, minSamplePerCell=30)` returns one of:

- `NOT_TESTED` — insufficient sample
- `TESTED_NEGATIVE` — acceptance rate below economic threshold
- `TESTED_INCONCLUSIVE` — mixed results
- `TESTED_PROMISING` — acceptance rate above threshold with adequate sample

This is a **post-hoc** decision aid. It does NOT change the primary outcome or the stopping rule. It is reported as a decision recommendation, not as evidence of marketplace viability.

---

## 13. Limitations

- Pilot is single-geography (NYC or declared pilot geography)
- Sample of 100 may be underpowered for sub-cell analysis
- Operator verification is not external credential verification
- W4-R completion evidence is `operator` level only (no GPS/provider API verification)
- The research flow cannot produce W3-M or W4-M evidence (structurally impossible)
