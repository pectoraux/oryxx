# ORYXX W3-R Pilot Deployment Checklist

**Status**: FROZEN — must be completed before `PREREGISTERED → ACTIVE`.

This checklist is enforced by the activation gate API (`mode: "activation_check"`). The experiment CANNOT move to ACTIVE until every gate passes.

---

## Pre-Activation Gates (automated)

The activation gate (`src/app/api/oryxx/willingness/experiment/route.ts`, `mode: "activation_check"`) verifies:

- [ ] Experiment status is `PREREGISTERED`
- [ ] Preregistration hash is present and verifies against the persisted design
- [ ] Consent text is non-empty
- [ ] Consent version ≥ 1
- [ ] Safety constraints are set (`maxDetourKm`, `maxExtraTimeMin`, `minCompensation`)
- [ ] Sample target > 0
- [ ] Stopping rule is non-empty
- [ ] Randomization seed is set
- [ ] Treatment design JSON is present and parseable
- [ ] Treatment cells are non-empty (at least one valid cell exists)
- [ ] Database schema includes `@@unique([experimentId, accountEmail])` constraint
- [ ] No existing enrollments with `evidenceTier = "W3-R"` or `"W4-R"` (prevents re-activation with stale evidence)
- [ ] No test participants (`@oryxx.test` emails) enrolled
- [ ] No test experiments (`HTTP Concurrency Test` names) present

---

## Manual Operator Checklist

Before manually activating, the operator must verify:

- [ ] Experiment design matches preregistration hash (verified by `verifyDesignHash`)
- [ ] Experiment status is `PREREGISTERED` (not `DRAFT`, not `ACTIVE`, not `COMPLETED`)
- [ ] Provider recruitment approved by the research lead
- [ ] Consent text reviewed and approved by the research ethics contact
- [ ] Safety constraints reviewed (`maxDetourKm ≤ 5`, `maxExtraTimeMin ≤ 20`, `minCompensation ≥ $1`)
- [ ] Compensation buckets reviewed (must match preregistration: `[1, 2, 3, 4, 5]`)
- [ ] Detour buckets reviewed (must match preregistration: `[0, 0.5, 1, 2, 3]`)
- [ ] Notice buckets reviewed (must match preregistration: `[0, 15, 60]`)
- [ ] Provider verification procedure defined (see `docs/research/w3-r-pilot-protocol.md` section G)
- [ ] Participant withdrawal procedure tested (in CI)
- [ ] Operator roles assigned (at least one admin account verified active)
- [ ] Data access permissions reviewed (only admin can view results)
- [ ] Monitoring dashboard ready (research operator dashboard)
- [ ] Emergency stop procedure defined (`mode: "pause"` → `ACTIVE → PAUSED`)
- [ ] No test participants in production (verified by activation gate)
- [ ] No test experiments in production (verified by activation gate)

---

## Evidence Baseline (must be zero before activation)

- [ ] W3-R = 0
- [ ] W4-R = 0
- [ ] W3-M = 0 (structurally impossible via research API)
- [ ] W4-M = 0 (structurally impossible via research API)

---

## Production Safety

- [ ] No CI test data in production Neon
- [ ] No synthetic acceptance observations
- [ ] No scenario results presented as empirical results
- [ ] Research dashboard labels simulation results as "SCENARIO MODEL — NOT OBSERVED"

---

## Activation Procedure

1. Admin runs `mode: "activation_check"` → must return `{ "canActivate": true, ... }`
2. Admin runs `mode: "activate"` → status moves to `ACTIVE`
3. The activation is logged as an audit event (hash-chained)
4. Enrollment, consent, offer creation, and transitions become available

**The activation is manual. The system does NOT auto-activate.**

---

## Post-Activation Monitoring

Once ACTIVE, the operator must:

- [ ] Monitor the research dashboard for integrity violations
- [ ] Verify W3-R/W4-R counts increment only through the valid event sequence
- [ ] Verify no W3-M/W4-M evidence appears (critical integrity event if it does)
- [ ] Track recruitment source and bias log entries
- [ ] Be ready to pause immediately on any integrity violation
