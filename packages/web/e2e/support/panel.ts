// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The browser setup shared by the suites that visit every page: signed in as
 * the panel user (panel.setup.ts saves the session), clock stopped at
 * PANEL_NOW, a fixed viewport, locale and time zone, and a chosen theme.
 *
 * `settle()` decides when a page is ready to be judged. The panel never
 * reaches `networkidle` on every page (some keep a stream open), so it waits
 * for the load event, the web fonts, and for the loading placeholders to go.
 */

import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { PANEL_NOW, WEB_PACKAGE_ROOT } from "../setup/test-env";

/** Where panel.setup.ts writes the signed-in session (gitignored). */
export const PANEL_STATE = join(WEB_PACKAGE_ROOT, ".playwright", "panel-state.json");

export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"];

export const PANEL_VIEWPORT = { width: 1440, height: 900 } as const;

export const test = base.extend<{ theme: Theme }>({
  theme: ["light", { option: true }],
  page: async ({ page, theme }, use) => {
    await page.clock.setFixedTime(PANEL_NOW);
    // next-themes reads this key before the first paint, so the page never
    // flashes the other theme.
    await page.addInitScript((value) => window.localStorage.setItem("theme", value), theme);
    await use(page);
  },
});

export { expect };

/** Elements the panel shows while it waits for data. */
const LOADING = '[data-slot="skeleton"], .animate-pulse, .animate-spin, [aria-busy="true"]';

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator(LOADING)).toHaveCount(0, { timeout: 15_000 });
}

/** Open a catalog path and wait until it can be judged. */
export async function openSettled(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} should answer 200`).toBe(200);
  await settle(page);
}
