# ORYXX W3-R Bias Log

**Status**: LIVING — updated throughout the pilot. Do not hide inconvenient observations.

This log tracks known confounds and biases in the W3-R pilot. Each entry is dated and signed by the operator who recorded it.

---

## Known Biases

### 1. Selection Bias
- **Description**: Recruited providers may not represent the general driver population.
- **Source**: Recruitment is through direct outreach (fleet partnerships, driver cooperatives).
- **Mitigation**: Record recruitment source per participant. Report acceptance rates stratified by recruitment source if sample permits.
- **Status**: Open — to be recorded per participant at enrollment.

### 2. Professional-Driver Bias
- **Description**: Recruited providers may be more experienced or cooperative than average drivers.
- **Source**: Operators select providers who are likely to complete the study.
- **Mitigation**: Document operator selection criteria in the verification record. Acknowledge in the analysis limitations.
- **Status**: Open.

### 3. Geography Bias
- **Description**: Pilot is limited to NYC (or declared pilot geography).
- **Source**: Recruitment is geographically bounded.
- **Mitigation**: Report geography on the experiment record. Do not generalize beyond the pilot geography.
- **Status**: Open — geography is stored on `AcceptanceExperiment.geography`.

### 4. Time-of-Day Bias
- **Description**: Offers are presented at varying times; acceptance may correlate with demand patterns.
- **Source**: Providers interact with the dashboard at their convenience.
- **Mitigation**: Record `hourOfDay` per response. Report acceptance rates stratified by time-of-day if sample permits.
- **Status**: Open — `hourOfDay` is collected per response.

### 5. Provider Type Bias
- **Description**: Taxi vs FHV providers may differ systematically in acceptance behavior.
- **Source**: Recruitment may skew toward one provider type.
- **Mitigation**: Record `providerType` per enrollment. Report acceptance rates stratified by provider type if sample permits.
- **Status**: Open — `providerType` is stored on `ExperimentEnrollment`.

### 6. Recruitment Source Bias
- **Description**: Fleet partnership vs cooperative outreach may select different populations.
- **Source**: Multiple recruitment channels.
- **Mitigation**: Record recruitment source per participant (in bias log, not in PII-bearing fields). Report stratified results if sample permits.
- **Status**: Open — recruitment source is recorded here, not in the database.

### 7. Attrition Bias
- **Description**: Providers may withdraw mid-study. Withdrawn providers' historical data is retained but no new offers are made.
- **Source**: Voluntary withdrawal.
- **Mitigation**: Track withdrawal count and timing. Report acceptance rate excluding withdrawn participants' post-withdrawal (which is structurally impossible anyway).
- **Status**: Open — withdrawal is tracked via `enrollment.status = "withdrawn"` and `withdrawnAt`.

### 8. Nonresponse Bias
- **Description**: Providers who view but do not decide are tracked as `PROVIDER_IGNORED` after 30-minute expiry.
- **Source**: Dashboard inattention.
- **Mitigation**: Report `PROVIDER_IGNORED` count separately. Wilson CI denominator includes ignored offers (they were viewed but not decided).
- **Status**: Open — `PROVIDER_IGNORED` is a tracked state.

### 9. Operator Effects
- **Description**: The operator who verifies providers may influence behavior through their verification interaction.
- **Source**: Operator-mediated verification.
- **Mitigation**: Record `verifiedBy` (operator email) per enrollment. If multiple operators participate, report stratified results.
- **Status**: Open — `verifiedAt` and verification method are recorded.

---

## Incident Log

(To be filled during the pilot. Each incident is dated, described, and resolved or escalated.)

### Template
```
- Date: YYYY-MM-DD
- Type: integrity_violation | safety | recruitment | other
- Description: ...
- Affected participants: ...
- Action taken: ...
- Resolution: ...
- Reported by: ...
```

---

## Pre-Pilot Observations

- The CI test suite (153 tests) verifies the production route against PostgreSQL 16 in an isolated container. This is NOT the production Neon deployment — production correctness is a separate claim.
- The sandbox `.env` uses SQLite; production uses PostgreSQL (Neon). The Prisma schema requires `postgresql` provider.
- The research instrument has produced zero W3-R/W4-R evidence. No participants have participated.
