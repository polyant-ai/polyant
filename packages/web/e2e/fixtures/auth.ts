// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Login helpers for the RBAC E2E specs. Authentication goes through the REAL
 * credentials login form (OSS has an always-on email/password provider), so no
 * Google OAuth and no cookie forging — the test exercises the full
 * web → Auth.js → engine credentials-verify → JWE-session path end to end.
 */

import { expect, type Page } from "@playwright/test";
import { getTestUser, type RbacRoleKey, type RbacTestUser } from "../setup/test-env.js";

/** Drive the /login form and wait until redirected off the login page. */
export async function login(page: Page, user: RbacTestUser): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.locator('button[type="submit"]').click();
  // The form calls signIn() then window.location.assign(callbackUrl). Seeded
  // users have must_change_password=false, so no password-change redirect.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  await expect(page.locator("#email")).toHaveCount(0);
}

/** Convenience: log in as the seeded user for a given role. */
export async function loginAs(page: Page, role: RbacRoleKey): Promise<void> {
  await login(page, getTestUser(role));
}
