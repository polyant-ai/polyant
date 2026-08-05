// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First DB-integrated RBAC E2E test.
 *
 * Proves the membership-management permission boundary end to end through the
 * UI: a real credentials login per role, a real navigation to /members, and an
 * assertion on BOTH the network result (200 vs 403 from the engine
 * PermissionGuard, proxied through Next) AND the rendered UI.
 *
 *   Owner  → org.member:manage granted → 200, members table visible.
 *   Member → not granted              → 403, no table (load fails → empty state).
 *   Viewer → not granted              → 403, no table.
 *
 * Only the database is integration-tested; no AI/channel service is touched by
 * this flow. Enforcement is real because the harness boots the engine with
 * AUTHZ_ENFORCE=true (see test-env.ts).
 */

import { expect, test, type Response } from "@playwright/test";
import { getTestUser } from "../setup/test-env.js";
import { loginAs } from "../fixtures/auth.js";

const MEMBERS_PATH = "/members";

/** GET …/api/organizations/:slug/members — the call the page makes on load. */
function isMembersListResponse(response: Response): boolean {
  const { pathname } = new URL(response.url());
  return (
    pathname.includes("/api/organizations/") &&
    pathname.endsWith("/members") &&
    response.request().method() === "GET"
  );
}

async function gotoMembersAndCaptureStatus(
  page: import("@playwright/test").Page,
): Promise<number> {
  const responsePromise = page.waitForResponse(isMembersListResponse, { timeout: 20_000 });
  await page.goto(MEMBERS_PATH);
  const response = await responsePromise;
  return response.status();
}

test.describe("RBAC — members management access", () => {
  test("Owner can manage members (200 + table)", async ({ page }) => {
    await loginAs(page, "owner");
    const status = await gotoMembersAndCaptureStatus(page);

    expect(status).toBe(200);
    await expect(page.getByRole("table")).toBeVisible();
    // The Owner's own row is present in the members table.
    await expect(page.getByRole("cell", { name: getTestUser("owner").email })).toBeVisible();
  });

  test("Member is denied (403 + no table)", async ({ page }) => {
    await loginAs(page, "member");
    const status = await gotoMembersAndCaptureStatus(page);

    expect(status).toBe(403);
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("Viewer is denied (403 + no table)", async ({ page }) => {
    await loginAs(page, "viewer");
    const status = await gotoMembersAndCaptureStatus(page);

    expect(status).toBe(403);
    await expect(page.getByRole("table")).toHaveCount(0);
  });
});
