// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tenant-scoped URL routing, end to end against a real engine + DB.
 *
 * The harness runs with AUTHZ_ENFORCE=true, so these tests also prove
 * GET /api/me is reachable under enforcement for every role — a Viewer holds
 * ORG_READ, and a route that declared no permission would 403 here.
 *
 * Migration 0051 seeds the organization as "default" and the workspace as
 * "general" — the slugs are deliberately not the same word.
 */

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/auth.js";

const ORG_SLUG = "default";
const WORKSPACE_SLUG = "general";
const CANONICAL_AGENTS = `/organizations/${ORG_SLUG}/workspaces/${WORKSPACE_SLUG}/instances`;

test.describe("tenant-scoped URLs", () => {
  test("the root path resolves to the organization dashboard", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto("/");

    await page.waitForURL(`**/organizations/${ORG_SLUG}`, { timeout: 20_000 });
  });

  test("a legacy flat URL forwards to its canonical form", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto("/instances");

    await page.waitForURL(`**${CANONICAL_AGENTS}`, { timeout: 20_000 });
  });

  test("a legacy deep link keeps its query string", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto("/conversations?id=does-not-exist");

    await page.waitForURL(
      (url) =>
        url.pathname ===
          `/organizations/${ORG_SLUG}/workspaces/${WORKSPACE_SLUG}/conversations` &&
        url.searchParams.get("id") === "does-not-exist",
      { timeout: 20_000 },
    );
  });

  test("the canonical workspace URL renders the agents page", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto(CANONICAL_AGENTS);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(CANONICAL_AGENTS);
  });

  test("an unknown organization slug is a 404", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto(`/organizations/ghost/workspaces/${WORKSPACE_SLUG}/instances`);

    await expect(page.locator("body")).toContainText(/could not be found/i);
  });

  test("an unknown workspace slug is a 404", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto(`/organizations/${ORG_SLUG}/workspaces/ghost/instances`);

    await expect(page.locator("body")).toContainText(/could not be found/i);
  });

  test("a Viewer can still resolve their tenancy under enforcement", async ({ page }) => {
    await loginAs(page, "viewer");

    await page.goto("/");

    // Reaching the dashboard means GET /api/me returned 200 with AUTHZ_ENFORCE=true.
    await page.waitForURL(`**/organizations/${ORG_SLUG}`, { timeout: 20_000 });
  });
});
