// ORYXX — Playwright config for browser-level research UI tests.
//
// This config drives a REAL browser against a REAL Next.js dev server
// backed by a REAL PostgreSQL test database. No API-handler imports, no
// Request-object construction — the browser exercises the actual UI.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false, // Sequential — tests share a DB and must not race
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Web server is started by the CI workflow / test script, NOT by Playwright,
  // because we need to set up the PostgreSQL database + Prisma schema first.
});
