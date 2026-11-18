// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Signs the panel user in once and saves the session for the panel suites.
 *
 * The saved state also marks the current release notes as read: a Platform
 * Admin otherwise gets the "What's new" dialog over every page, and a page
 * under a modal dialog is not the page — axe would only judge the dialog.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { test as setup, expect } from "@playwright/test";
import { loginWithCredentials } from "../fixtures/auth";
import { PANEL_USER } from "../setup/test-env";
import { PANEL_STATE } from "../support/panel";

/** Mirrors STORAGE_KEY in src/hooks/use-changelog-check.ts. */
const LAST_SEEN_VERSION_KEY = "polyant-last-seen-version";

setup("sign in the panel user", async ({ page }) => {
  await loginWithCredentials(page, PANEL_USER.email, PANEL_USER.password);

  const changelog = await page.request.get("/changelog.json");
  expect(changelog.ok(), "the build serves /changelog.json").toBe(true);
  const { version } = (await changelog.json()) as { version: string };
  expect(version, "the changelog names a version").toBeTruthy();
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [LAST_SEEN_VERSION_KEY, version]);

  mkdirSync(dirname(PANEL_STATE), { recursive: true });
  await page.context().storageState({ path: PANEL_STATE });
});
