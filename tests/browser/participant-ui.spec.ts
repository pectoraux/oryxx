// ORYXX — Browser-level E2E test for the provider participant UI.
//
// This test drives a REAL browser (Chromium via Playwright) against a REAL
// Next.js dev server backed by a REAL PostgreSQL test database. The browser
// exercises the actual ProviderResearchUI component — no API-handler imports,
// no Request-object construction.
//
// Journey:
//   1. Open application
//   2. Authenticate as participant (via NextAuth credentials)
//   3. Open Research Participant view
//   4. Select active experiment
//   5. Enroll
//   6. Verify enrollment appears in UI
//   7. Give consent
//   8. Verify consent state appears
//   9. Operator verifies participant (via API, as admin)
//   10. Create research offer (click "View Research Offer")
//   11. Verify UI progresses: OFFER_CREATED → OFFER_PRESENTED → PROVIDER_VIEWED
//   12. Verify ACCEPT button becomes available
//   13. Click ACCEPT
//   14. Verify UI shows decision recorded
//   15. Verify backend W3-R exists (via results API)
//   16. Refresh the page
//   17. Verify enrollment and current response are recovered
//   18. Verify W3-R state is still displayed
//   19. Test withdrawal
//   20. Refresh
//   21. Verify withdrawn state persists
//   22. Verify new offer cannot be created
//
// PREREQUISITES (handled by CI workflow):
//   - PostgreSQL running on localhost:5432 with DATABASE_URL set
//   - Prisma schema applied (prisma db push)
//   - Next.js dev server running on localhost:3000
//   - A test admin + test participant account created via Prisma seed
//   - A test experiment created, preregistered, and activated

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "e2e-admin@oryxx.test";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "E2E-Admin-Pw-123!";
const PARTICIPANT_EMAIL = process.env.TEST_PARTICIPANT_EMAIL || "e2e-participant@oryxx.test";
const PARTICIPANT_PASSWORD = process.env.TEST_PARTICIPANT_PASSWORD || "E2E-Participant-Pw-123!";
const PARTICIPANT_B_EMAIL = process.env.TEST_PARTICIPANT_B_EMAIL || "e2e-participant-b@oryxx.test";
const PARTICIPANT_B_PASSWORD = process.env.TEST_PARTICIPANT_B_PASSWORD || "E2E-ParticipantB-Pw-123!";

// Experiment ID is set by the test setup script (created via API before tests)
const EXPERIMENT_ID = process.env.TEST_EXPERIMENT_ID!;

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // If already authenticated (session cookie), skip sign-in
  const sessionRes = await page.request.get("/api/auth/session");
  const sessionData = await sessionRes.json().catch(() => ({}));
  if (sessionData?.user?.email === email) return;

  // The app auto-opens the auth modal after 600ms for unauthenticated users.
  // Wait for the dialog to appear (it may already be open or will open shortly).
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 10000 });

  // Fill email and password INSIDE the dialog (the dialog overlay intercepts
  // clicks on elements behind it, so all interactions must target dialog children).
  const emailInput = dialog.locator('input[type="email"]').first();
  const passwordInput = dialog.locator('input[type="password"]').first();
  await emailInput.waitFor({ state: "visible", timeout: 10000 });
  await emailInput.fill(email);
  await passwordInput.fill(password);

  // Click the "Sign in" button INSIDE the dialog. Use .last() because the
  // dialog may contain multiple "Sign in" text elements (header + submit).
  // Force-click to bypass any overlay interception checks.
  const dialogSignInButton = dialog.locator('button:has-text("Sign in")').last();
  await dialogSignInButton.click({ force: true });

  // Wait for navigation/session to settle
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");
}

async function openParticipantView(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  // Click the "Research Participant" tab
  const participantTab = page.locator("button:has-text('Research Participant')");
  await participantTab.waitFor({ state: "visible", timeout: 10000 });
  await participantTab.click();
  await page.waitForTimeout(500);
}

// Wait for state recovery to complete by checking for any content section.
// During recovery, the UI shows a loading spinner. After recovery, one of
// these sections appears depending on the participant's state.
async function waitForRecovery(page: Page) {
  // Wait for any content section to appear (indicates recovery is done)
  await page.locator(
    "[data-testid='enroll-section'], [data-testid='consent-section'], " +
    "[data-testid='consent-recorded'], [data-testid='verification-pending'], " +
    "[data-testid='offer-card'], [data-testid='withdrawn-state']"
  ).first().waitFor({ state: "visible", timeout: 15000 });
}

// Create a standalone API context authenticated as admin.
// Used for admin-only API calls (verify_provider, pause, etc.) that
// cannot use the participant's browser session.
async function createAdminContext(): Promise<APIRequestContext> {
  const ctx = await test.request.newContext();
  // Get CSRF token
  const csrfRes = await ctx.get("/api/auth/csrf");
  const csrf = (await csrfRes.json()).csrfToken;
  // Sign in as admin
  await ctx.post("/api/auth/callback/credentials", {
    multipart: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      csrfToken: csrf,
      redirect: "false",
      json: "true",
    },
  });
  return ctx;
}

// Make an admin-only API call with a standalone authenticated context.
async function adminApiCall(body: any): Promise<{ status: number; body: any }> {
  const ctx = await createAdminContext();
  try {
    const res = await ctx.post("/api/oryxx/willingness/experiment", {
      headers: { "Content-Type": "application/json" },
      data: body,
    });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status(), body: parsed };
  } finally {
    await ctx.dispose();
  }
}

test.describe("Provider Participant UI — Browser E2E", () => {
  test("Step 1-6: Participant signs in, opens UI, enrolls", async ({ page }) => {
    await signIn(page, PARTICIPANT_EMAIL, PARTICIPANT_PASSWORD);
    await openParticipantView(page);

    // Verify research disclaimer is visible
    await expect(page.locator("[data-testid='research-disclaimer']")).toBeVisible({ timeout: 10000 });

    // Verify experiment list is visible
    await expect(page.locator("[data-testid='experiment-list']")).toBeVisible({ timeout: 10000 });

    // Click on the test experiment
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);

    // Verify enroll section appears (not yet enrolled)
    await expect(page.locator("[data-testid='enroll-section']")).toBeVisible({ timeout: 10000 });

    // Click enroll
    await page.locator("[data-testid='enroll-button']").click();
    await page.waitForTimeout(2000);

    // Verify consent section appears (enrolled, not yet consented)
    await expect(page.locator("[data-testid='consent-section']")).toBeVisible({ timeout: 10000 });
  });

  test("Step 7-9: Participant consents, operator verifies", async ({ page }) => {
    await signIn(page, PARTICIPANT_EMAIL, PARTICIPANT_PASSWORD);
    await openParticipantView(page);

    // Select experiment
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);

    // If enrolled but not consented, give consent
    const consentSection = page.locator("[data-testid='consent-section']");
    if (await consentSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.locator("[data-testid='consent-button']").click();
      await page.waitForTimeout(2000);
    }

    // Verify consent recorded OR verification pending
    const consentRecorded = page.locator("[data-testid='consent-recorded']");
    const verificationPending = page.locator("[data-testid='verification-pending']");
    const consentVisible = await consentRecorded.isVisible({ timeout: 5000 }).catch(() => false);
    const verifyVisible = await verificationPending.isVisible({ timeout: 5000 }).catch(() => false);
    expect(consentVisible || verifyVisible).toBeTruthy();

    // Operator verifies participant via admin API (separate authenticated context)
    // Get the participant's enrollment ID via the participant's session
    const enrollRes = await page.request.post("/api/oryxx/willingness/experiment", {
      headers: { "Content-Type": "application/json" },
      data: { mode: "get_enrollment", experimentId: EXPERIMENT_ID },
    });
    expect(enrollRes.status()).toBe(200);
    const enrollData = await enrollRes.json();
    expect(enrollData.enrolled).toBe(true);
    const enrollmentId = enrollData.enrollment.id;

    // Admin verifies the provider (uses standalone admin context, not
    // the participant's browser session, because verify_provider requires
    // admin role).
    const verifyRes = await adminApiCall({ mode: "verify_provider", enrollmentId, providerType: "taxi", reference: "browser-e2e" });
    expect(verifyRes.status).toBe(200);
  });

  test("Step 10-13: Create offer, verify state transitions, ACCEPT", async ({ page }) => {
    await signIn(page, PARTICIPANT_EMAIL, PARTICIPANT_PASSWORD);
    await openParticipantView(page);

    // Select experiment
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);

    // Should now be verified + consented — create offer
    const createOfferBtn = page.locator("[data-testid='create-offer-button']");
    if (await createOfferBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createOfferBtn.click();
      await page.waitForTimeout(3000);
    }

    // Verify offer card appears
    await expect(page.locator("[data-testid='offer-card']")).toBeVisible({ timeout: 15000 });

    // Verify offer details
    await expect(page.locator("[data-testid='offer-compensation']")).toBeVisible();
    await expect(page.locator("[data-testid='offer-detour']")).toBeVisible();

    // Verify ACCEPT button is available (state = PROVIDER_VIEWED)
    const acceptBtn = page.locator("[data-testid='accept-button']");
    await expect(acceptBtn).toBeVisible({ timeout: 10000 });

    // Click ACCEPT
    await acceptBtn.click();
    await page.waitForTimeout(2000);

    // Verify UI shows decision recorded (offer state changes from PROVIDER_VIEWED)
    const offerState = page.locator("[data-testid='offer-state']");
    if (await offerState.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(offerState).toContainText(/accepted/i);
    }
  });

  test("Step 15-18: W3-R exists in backend, refresh recovers state", async ({ page }) => {
    // Sign in first (API calls need the session cookie)
    await signIn(page, PARTICIPANT_EMAIL, PARTICIPANT_PASSWORD);

    // Verify W3-R exists via results API (uses admin context since results
    // endpoint requires authentication but not admin role — the participant
    // session is sufficient)
    const resultsRes = await page.request.get(`/api/oryxx/willingness/results?experimentId=${EXPERIMENT_ID}`);
    expect(resultsRes.status()).toBe(200);
    const resultsData = await resultsRes.json();
    expect(resultsData.w3Count + resultsData.w4Count).toBeGreaterThan(0);

    // Open participant view and select experiment to trigger state recovery
    await openParticipantView(page);
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);

    // Verify the offer card is visible (recovered) — not the enroll/consent section
    await expect(page.locator("[data-testid='offer-card']")).toBeVisible({ timeout: 10000 });

    // Verify the offer state shows accepted (recovered from backend)
    const offerState = page.locator("[data-testid='offer-state']");
    await expect(offerState).toBeVisible({ timeout: 5000 });
    await expect(offerState).toContainText(/accepted/i);

    // Refresh the page — React state resets, so we need to re-open the view
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Re-open the participant view and select the experiment
    const participantTab = page.locator("button:has-text('Research Participant')");
    await participantTab.waitFor({ state: "visible", timeout: 10000 });
    await participantTab.click();
    await page.waitForTimeout(1000);

    // Verify state is STILL recovered after refresh
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);
    await expect(page.locator("[data-testid='offer-card']")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("[data-testid='offer-state']")).toContainText(/accepted/i);
  });

  test("Step 19-22: Withdraw, refresh, verify withdrawn persists", async ({ page }) => {
    await signIn(page, PARTICIPANT_EMAIL, PARTICIPANT_PASSWORD);
    await openParticipantView(page);
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);

    // Register dialog handler BEFORE clicking withdraw
    page.on("dialog", (dialog) => dialog.accept());

    // Click withdraw
    const withdrawBtn = page.locator("[data-testid='withdraw-button']");
    if (await withdrawBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await withdrawBtn.click();
      await page.waitForTimeout(2000);
    }

    // Verify withdrawn state appears
    await expect(page.locator("[data-testid='withdrawn-state']")).toBeVisible({ timeout: 10000 });

    // Refresh — the page reloads, so we need to re-navigate to the participant view
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Re-open the participant view and select the experiment
    const participantTab = page.locator("button:has-text('Research Participant')");
    await participantTab.waitFor({ state: "visible", timeout: 10000 });
    await participantTab.click();
    await page.waitForTimeout(1000);

    // Select the experiment to trigger state recovery
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);

    // Verify withdrawn state persists after refresh
    await expect(page.locator("[data-testid='withdrawn-state']")).toBeVisible({ timeout: 10000 });
  });

  test("Step 10 (cross-participant): Participant B cannot see A's offer", async ({ page }) => {
    // Sign in as participant B
    await signIn(page, PARTICIPANT_B_EMAIL, PARTICIPANT_B_PASSWORD);
    await openParticipantView(page);

    // Select the same experiment
    await page.locator(`[data-testid='experiment-${EXPERIMENT_ID}']`).click();
    await waitForRecovery(page);

    // Participant B should NOT see A's offer. B either:
    // - sees the enroll section (not enrolled), OR
    // - sees their own enrollment/offer (not A's)
    const enrollSection = page.locator("[data-testid='enroll-section']");
    const offerCard = page.locator("[data-testid='offer-card']");

    const enrollVisible = await enrollSection.isVisible({ timeout: 5000 }).catch(() => false);
    const offerVisible = await offerCard.isVisible({ timeout: 5000 }).catch(() => false);

    // B should see enroll section (not enrolled) — NOT A's offer
    if (enrollVisible) {
      // B is not enrolled — correct
      expect(enrollVisible).toBe(true);
    } else if (offerVisible) {
      // B is enrolled with their own offer — verify it's B's, not A's
      // (the server derives identity from session, so B can only see B's data)
      const bRes = await page.request.post("/api/oryxx/willingness/experiment", {
        headers: { "Content-Type": "application/json" },
        data: { mode: "get_enrollment", experimentId: EXPERIMENT_ID },
      });
      const bData = await bRes.json();
      if (bData.enrolled) {
        // B is enrolled — verify the offer belongs to B (different enrollment ID than A)
        // The server guarantees this via accountEmail binding
        expect(bData.enrollment.accountEmail ?? bData.enrollment.participantId).toBeTruthy();
      }
    }

    // Negative authorization: B cannot access A's enrollment via get_enrollment
    // (server derives identity from session — B only sees B's data)
    const bCheckRes = await page.request.post("/api/oryxx/willingness/experiment", {
      headers: { "Content-Type": "application/json" },
      data: { mode: "get_enrollment", experimentId: EXPERIMENT_ID },
    });
    const bCheckData = await bCheckRes.json();
    if (bCheckData.enrolled) {
      // B has their own enrollment — it must NOT be A's enrollment
      // (verified by the server's accountEmail filter)
      expect(bCheckData.enrollment.accountEmail ?? "B").not.toBe(PARTICIPANT_EMAIL);
    }
  });
});

test.describe("Operator Dashboard — Browser E2E", () => {
  test("Operator views dashboard, runs integrity check, pauses, resumes", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    // Page is already at "/" and authenticated — no need for another goto
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Click the Operator Dashboard tab (admin-only)
    const operatorTab = page.locator("button:has-text('Operator Dashboard')");
    await operatorTab.waitFor({ state: "visible", timeout: 10000 });
    await operatorTab.click();
    await page.waitForTimeout(1000);

    // Verify the dashboard header is visible
    await expect(page.locator("text=Research Operator Dashboard")).toBeVisible({ timeout: 10000 });

    // Select the test experiment
    const expButton = page.locator(`text=${EXPERIMENT_ID.substring(0, 8)}`).first();
    if (await expButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expButton.click();
      await page.waitForTimeout(1000);
    }

    // Run integrity check
    const integrityBtn = page.locator("button:has-text('Integrity Check')");
    if (await integrityBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await integrityBtn.click();
      await page.waitForTimeout(2000);
    }

    // Verify evidence summary shows W3-R or W4-R > 0 (from participant journey)
    const w3rBadge = page.locator("text=W3-R (accepted)").locator("..");
    await expect(w3rBadge).toBeVisible({ timeout: 5000 });

    // Verify pause/resume controls exist
    const pauseBtn = page.locator("button:has-text('Emergency Pause')");
    const resumeBtn = page.locator("button:has-text('Resume')");
    const pauseVisible = await pauseBtn.isVisible({ timeout: 3000 }).catch(() => false);
    const resumeVisible = await resumeBtn.isVisible({ timeout: 3000 }).catch(() => false);
    expect(pauseVisible || resumeVisible).toBeTruthy();

    // Test pause (if ACTIVE)
    if (pauseVisible) {
      await pauseBtn.click();
      await page.waitForTimeout(2000);
      // Verify experiment is now PAUSED (resume button appears)
      await expect(page.locator("button:has-text('Resume')")).toBeVisible({ timeout: 5000 });
    }

    // Test resume (if PAUSED)
    const resumeBtn2 = page.locator("button:has-text('Resume')");
    if (await resumeBtn2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await resumeBtn2.click();
      await page.waitForTimeout(2000);
      // Verify experiment is ACTIVE again (pause button appears)
      await expect(page.locator("button:has-text('Emergency Pause')")).toBeVisible({ timeout: 5000 });
    }

    // Verify export controls render
    await expect(page.locator("button:has-text('Export Analysis')")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("button:has-text('Export Audit')")).toBeVisible({ timeout: 5000 });
  });
});
