// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The browser setup shared by the suites that visit every page: signed in as
 * the panel user (panel.setup.ts saves the session), clock stopped at
 * PANEL_NOW, reduced motion, a fixed viewport, locale and time zone, and a
 * chosen theme.
 *
 * `settle()` decides when a page is ready to be judged. The panel never
 * reaches `networkidle` on every page (some keep a stream open), so it waits
 * for the load event, the web fonts, and for the loading placeholders to go.
 */

import { readFileSync } from "node:fs";
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
    // The panel turns its entrance animations off under reduced motion, so a
    // page is judged at rest, not halfway through fading in.
    await page.emulateMedia({ reducedMotion: "reduce" });
    // next-themes reads this key before the first paint, so the page never
    // flashes the other theme.
    await page.addInitScript((value) => window.localStorage.setItem("theme", value), theme);
    await use(page);
  },
});

export { expect };

/** Elements the panel shows while it waits for data. */
const LOADING = '[data-slot="skeleton"], .animate-pulse, .animate-spin, [aria-busy="true"]';

/**
 * The words the panel shows while it waits for data ("Loading..."), from the
 * English locale the suites run in: every `*.loading` message. Many waiting
 * states are only that text, with no placeholder element to wait for.
 */
const LOADING_TEXT = (() => {
  const messages = JSON.parse(
    readFileSync(join(WEB_PACKAGE_ROOT, "src", "lib", "i18n", "locales", "en.json"), "utf8"),
  ) as Record<string, unknown>;
  const texts = Object.entries(messages)
    .filter(([key, value]) => key.endsWith(".loading") && typeof value === "string")
    .map(([, value]) => (value as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // An empty list would match every empty element and never settle.
  if (texts.length === 0) throw new Error("no *.loading message in the English locale");
  return new RegExp(`^\\s*(${texts.join("|")})\\s*$`);
})();

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator(LOADING)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(LOADING_TEXT)).toHaveCount(0, { timeout: 15_000 });
}

/** Open a catalog path and wait until it can be judged. */
export async function openSettled(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} should answer 200`).toBe(200);
  await settle(page);
}
