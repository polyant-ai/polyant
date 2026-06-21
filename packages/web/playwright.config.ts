// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Playwright config for the RBAC E2E harness. Self-contained: it boots the
 * engine (NestJS) and the web (Next.js) against the dedicated test database on
 * fixed ports, then runs the specs in a real browser.
 *
 * The test database is created + migrated + seeded by `e2e/setup/prepare-db.ts`,
 * sequenced BEFORE `playwright test` in the `test:e2e` npm script (the engine
 * does not migrate on boot, so the schema must exist first).
 *
 * Run: `npm run test:e2e -w @polyant/web`
 * Prereq: PostgreSQL up (`docker compose up -d postgres`) + browsers installed
 *         (`npx playwright install chromium`).
 */

import { defineConfig, devices } from "@playwright/test";
import {
  buildEngineEnv,
  buildWebEnv,
  ENGINE_URL,
  REPO_ROOT,
  WEB_PACKAGE_ROOT,
  WEB_PORT,
  WEB_URL,
} from "./e2e/setup/test-env.js";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // Shared test database → serialize to keep state deterministic.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: WEB_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Boot both services. Playwright waits for each `url` to answer before tests.
  webServer: [
    {
      command: "npm run dev:engine",
      cwd: REPO_ROOT,
      url: `${ENGINE_URL}/health`,
      env: buildEngineEnv(),
      reuseExistingServer: !isCI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
    {
      // Production build + start (NOT `next dev`): Next 16 allows only one dev
      // server per project dir, so a running `next dev` would block us. Build +
      // start into an isolated distDir (NEXT_DIST_DIR) coexists with it and is
      // the correct CI pattern anyway. First run is slower (a full build).
      command: `npm run build && npm run start -- --port ${WEB_PORT}`,
      cwd: WEB_PACKAGE_ROOT,
      url: WEB_URL,
      env: buildWebEnv(),
      reuseExistingServer: !isCI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 300_000,
    },
  ],
});
