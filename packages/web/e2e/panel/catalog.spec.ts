// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keeps the page catalog honest, because the accessibility and screenshot
 * suites only see what it lists:
 *
 * - every route has a value for each dynamic segment, or is skipped on purpose;
 * - every exception names a route that still exists;
 * - every declared redirect lands exactly where it says;
 * - every listed page answers 200 and stays on its own URL, so an undeclared
 *   redirect cannot make the suites judge some other page under its name.
 */

import {
  agentTabs,
  catalogPages,
  catalogRedirects,
  catalogSkipped,
  discoverRoutes,
} from "../support/page-catalog";
import { expect, openSettled, test } from "../support/panel";

const routes = discoverRoutes();

test.describe("page catalog", () => {
  test("discovers the panel's routes and agent sections", () => {
    // Non-vacuity: a broken discovery would turn both suites into no-ops.
    expect(routes.length).toBeGreaterThan(15);
    expect(agentTabs().length).toBeGreaterThan(10);
    expect(catalogPages().length).toBeGreaterThan(agentTabs().length + 5);
  });

  test("fills every dynamic segment or skips the route on purpose", () => {
    const skipped = catalogSkipped();
    const unfilled = routes
      .filter((r) => r.missing.length > 0 && !(r.pattern in skipped))
      .map((r) => `${r.source}: no value for ${r.missing.join(", ")}`);
    expect(unfilled, "add the segment to PARAMS in page-catalog.ts, or skip the route with a reason").toEqual([]);
  });

  test("lists exceptions only for routes that exist", () => {
    const known = new Set(routes.flatMap((r) => [r.pattern, r.path].filter((p): p is string => p !== null)));
    const stale = [...Object.keys(catalogRedirects()), ...Object.keys(catalogSkipped())].filter((p) => !known.has(p));
    expect(stale, "remove exceptions for routes that are gone").toEqual([]);
  });

  for (const [from, to] of Object.entries(catalogRedirects())) {
    test(`redirect ${from} lands on ${to}`, async ({ page }) => {
      await page.goto(from);
      await expect.poll(() => {
        const url = new URL(page.url());
        return url.pathname + url.search;
      }).toBe(to);
    });
  }
});

for (const anonymous of [false, true]) {
  test.describe(anonymous ? "pages without a session" : "pages with a session", () => {
    if (anonymous) test.use({ storageState: { cookies: [], origins: [] } });
    for (const entry of catalogPages().filter((p) => p.anonymous === anonymous)) {
      test(`page ${entry.path} renders in place`, async ({ page }) => {
        await openSettled(page, entry.path);
        const url = new URL(page.url());
        expect(url.pathname + url.search, "an undeclared redirect: add it to REDIRECTS").toBe(entry.path);
      });
    }
  });
}
