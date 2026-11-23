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
  FAKE_MODEL_PORT,
  FAKE_MODEL_URL,
  FAKE_TWILIO_PORT,
  FAKE_TWILIO_URL,
  REPO_ROOT,
  WEB_PACKAGE_ROOT,
  WEB_PORT,
  WEB_URL,
} from "./e2e/setup/test-env.js";
import { PANEL_STATE, PANEL_VIEWPORT } from "./e2e/support/panel";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  /*
    One worker by default: the RBAC specs share users and rewrite their
    guidance state. The panel suites only read, as their own user, so a run
    of just those (`--project=panel`) can raise it with E2E_WORKERS.
  */
  workers: Number(process.env.E2E_WORKERS ?? 1),
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

  projects: [
    { name: "chromium", testMatch: "rbac/**/*.spec.ts", use: { ...devices["Desktop Chrome"] } },
    // Signs the panel user in once; the panel suites reuse the session.
    { name: "panel-setup", testMatch: "panel/panel.setup.ts", use: { ...devices["Desktop Chrome"] } },
    {
      // Every page of the panel: the catalog's own checks and accessibility.
      name: "panel",
      testMatch: ["panel/**/*.spec.ts", "a11y/**/*.spec.ts"],
      dependencies: ["panel-setup"],
      fullyParallel: true,
      use: {
        ...devices["Desktop Chrome"],
        storageState: PANEL_STATE,
        viewport: PANEL_VIEWPORT,
        locale: "en-US",
        timezoneId: "Europe/Rome",
      },
    },
    {
      // One real turn through the engine and the web, against the fake model.
      name: "turn",
      testMatch: "turn/**/*.spec.ts",
      dependencies: ["panel-setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: PANEL_STATE,
        viewport: PANEL_VIEWPORT,
        locale: "en-US",
      },
    },
  ],

  // Boot the fake model, the fake Twilio, the engine and the web. Playwright waits for each `url` to answer before tests.
  webServer: [
    {
      // The fake OpenAI model the engine's `openai` provider is pointed at.
      command: `node e2e/support/fake-model.mjs ${FAKE_MODEL_PORT}`,
      cwd: WEB_PACKAGE_ROOT,
      url: `${FAKE_MODEL_URL}/__calls`,
      reuseExistingServer: !isCI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
    {
      // The fake Twilio the engine's WhatsApp channel is pointed at.
      command: `node e2e/support/fake-twilio.mjs ${FAKE_TWILIO_PORT}`,
      cwd: WEB_PACKAGE_ROOT,
      url: `${FAKE_TWILIO_URL}/__requests`,
      reuseExistingServer: !isCI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
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
