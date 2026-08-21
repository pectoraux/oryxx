# Task: ORYXX Two-Sided Marketplace HTTP Integration Tests

## Task ID
`twosided-marketplace-tests`

## Agent Name
`code-agent`

## Summary

Created `/home/z/my-project/tests/oryxx-marketplace-twosided.test.ts` — a
complete HTTP-level integration test suite for the two-sided marketplace
transaction spine that was added to
`src/app/api/oryxx/marketplace/route.ts`.

## Scope

The new test file exercises the three new marketplace modes added to the
production route handler:

- `buyer_accept_offer` (also aliased to legacy `accept_offer`) — buyer side
  only, transitions `PENDING → BUYER_ACCEPTED`. NO agreement is created.
- `provider_accept_offer` — provider side, transitions
  `BUYER_ACCEPTED → PROVIDER_ACCEPTED`, creates `MarketplaceAgreement`
  (status=`ACTIVE`), reserves supply, calls `adapter.accept()`. Provider
  identity is resolved server-side from the session — in SANDBOX any
  authenticated user resolves to the `sandbox-rideshare` provider.
- `provider_reject_offer` — provider rejects, transitions to `REJECTED`.

Both `authorize_payment` and `reserve_execution` are now gated on
`agreement.status === "ACTIVE"`.

## Test Harness

Mirrors `tests/oryxx-marketplace-http.test.ts` exactly:

- `bun:test` runner (`test`, `expect`, `describe`, `beforeAll`, `afterAll`,
  `mock`).
- `AsyncLocalStorage` for per-request session identity.
- `mock.module("next-auth", …)` so `getServerSession(authOptions)` returns
  the ALS store.
- Imports the ACTUAL `POST` handler from `src/app/api/oryxx/marketplace/route`
  (after the mock is registered).
- Uses `PrismaClient` pointed at the same PostgreSQL as the production
  route (`process.env.DIRECT_URL ?? process.env.DATABASE_URL`).
- Environment fix-up for `DATABASE_URL` (restores the production PostgreSQL
  contract when the sandbox shell shadows it with SQLite).
- Cleanup in `afterAll` walks every relation in reverse-dependency order so
  foreign keys never block a delete (identical to the existing test file).

Two distinct test users (`buyer` and `provider`) are created per run via
`emailFor(label)`. In the sandbox the provider email is effectively cosmetic
(provider identity is resolved from ANY authenticated session) but the
separation mirrors a real two-sided marketplace and verifies cross-actor
invocation.

## Test Cases (12 total)

1. **Buyer accept transitions to BUYER_ACCEPTED (no agreement)** — Full
   chain → `buyer_accept_offer`. Verifies `offer.status === "BUYER_ACCEPTED"`,
   `agreementCount === 0`, opportunity `BUYER_ACCEPTED`, demand still
   `MATCHED`, supply still `AVAILABLE`.
2. **Provider accept creates agreement** — After buyer accepts, a different
   user calls `provider_accept_offer`. Verifies `offer.status ===
   "PROVIDER_ACCEPTED"`, agreement `ACTIVE`, supply `RESERVED`, opportunity
   `ACCEPTED`.
3. **Payment before agreement is rejected** — Buyer accepts (no provider
   accept), then `authorize_payment` returns 4xx (`400` or `404` — both signal
   the gate). No PaymentIntent created.
4. **Execution before agreement is rejected** — Same setup, then
   `reserve_execution` returns 4xx. No execution created.
5. **Provider reject transitions to REJECTED** — After buyer accepts, a
   different user calls `provider_reject_offer`. Verifies `offer.status ===
   "REJECTED"`, `agreementCount === 0`, opportunity `REJECTED`.
6. **Provider cannot accept before buyer** — `provider_accept_offer` on a
   PENDING offer returns 400 with "BUYER_ACCEPTED" in the error message.
7. **Buyer can call provider_accept_offer in sandbox** — Verifies the
   actual implementation behavior: the buyer (who just buyer-accepted)
   CAN successfully call `provider_accept_offer` because the sandbox
   resolves provider identity from any authenticated session. Test accepts
   either 200 (success — actual behavior) or 403 (if a role check is ever
   added). Currently expects 200 with PROVIDER_ACCEPTED + ACTIVE agreement.
8. **Full two-sided transaction completes** — buyer_accept →
   provider_accept → authorize_payment → capture_payment →
   reserve_execution → dispatch → complete_execution. Verifies execution
   `COMPLETED`, demand `COMPLETED`, settlement `SETTLED`.
9. **Double provider accept: second call rejected with 400** — First
   `provider_accept_offer` succeeds; second returns 400 (offer is
   PROVIDER_ACCEPTED, not BUYER_ACCEPTED). No duplicate agreement.
10. **Marketplace objects tagged correctly** — After a full two-sided
    completed transaction, verifies `isMarketplaceOpportunity === true`
    and `researchStimulus === false` on opportunity, offer, agreement,
    execution (plus `environment === "SANDBOX"` everywhere, including
    payment intent and settlement).
11. **Sandbox execution evidenceEligible=false** — After
    `reserve_execution`, verifies `execution.evidenceEligible === false`
    and `environment === "SANDBOX"` on both the response and the DB row.
12. **Unauthenticated provider_accept → 401** — `callRouteUnauthenticated`
    on `provider_accept_offer` returns 401 ("Authentication required.")
    before the provider-identity check.

## Implementation Details Discovered

Reading `src/app/api/oryxx/marketplace/route.ts` (lines 178–192):

```ts
async function requireProviderIdentity(): Promise<ProviderIdentity | null> {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const role = (session.user as { role?: string } | null)?.role;
  const email = (session.user as { email?: string | null } | null)?.email;
  if (!email) return null;
  // In sandbox, any authenticated user can act as the sandbox provider.
  return {
    providerId: "sandbox-rideshare",
    resourceId: "sandbox-vehicle-1",
    environment: "SANDBOX",
  };
}
```

This means ANY authenticated session (including the buyer's) resolves to the
sandbox provider identity. Test 7 leverages this to verify the buyer CAN
call `provider_accept_offer` — reflecting the actual sandbox behavior.

For tests 3 and 4 (gating), the implementation has two paths:
- `if (!agreement) return 404;` — when no agreement exists for the supplied
  ID (which is the case after `buyer_accept_offer` only, since no agreement
  is created).
- `if (agreement.status !== "ACTIVE") return 400;` — when an agreement
  exists but isn't ACTIVE.

Both signal the gate ("no payment/execution before two-sided agreement").
The tests assert `expect([400, 404]).toContain(res.status)` plus an error
message matching `/agreement|active/i`.

## Validation

- `bunx eslint tests/oryxx-marketplace-twosided.test.ts` — passes (no
  errors, no warnings).
- `bunx tsc --noEmit --project tsconfig.json` — the only TS error on this
  file is `Cannot find module 'bun:test'`, which is a pre-existing
  project-wide config issue (the existing
  `tests/oryxx-marketplace-http.test.ts` has the same error). Bun's test
  runner handles the import natively at runtime.
- `bun build tests/oryxx-marketplace-twosided.test.ts --no-bundle` —
  parses cleanly, no syntax errors.
- `bun test` runtime — the file loads, mocks register, route handler
  imports successfully, and the test reaches `db.transportationDemand.findMany`
  in `cleanupTestData` before failing on the database URL (the sandbox env
  uses SQLite, but the test is designed for a PostgreSQL CI service
  container, exactly like the existing test file).

## Files

- Created: `/home/z/my-project/tests/oryxx-marketplace-twosided.test.ts`
  (947 lines).
- Read (for reference): `tests/oryxx-marketplace-http.test.ts`,
  `src/app/api/oryxx/marketplace/route.ts`, `prisma/schema.prisma`,
  `src/lib/auth/options.ts`, `tsconfig.json`, `package.json`.
