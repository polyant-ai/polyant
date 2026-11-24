// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Accessibility of every page of the panel, in both themes, checked by axe
 * against WCAG 2.2 level A and AA.
 *
 * axe runs in the real browser on the built panel, so it sees what jsdom
 * cannot: computed colours and contrast, the accessible names of rendered
 * controls, landmark and heading structure.
 *
 * It is a ratchet, like the coverage floors. `known-violations.json` lists
 * what was already there when a rule was adopted, as rule × page × theme
 * with a node count:
 *
 * - a violation that is not listed, or more nodes than listed, fails;
 * - a listed violation that is gone fails too, until its entry is removed,
 *   so the list only ever shrinks.
 *
 * A build with more pages adds its own list in `known-violations.extra.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { catalogPages } from "../support/page-catalog";
import { expect, openSettled, test, THEMES } from "../support/panel";

/** WCAG 2.0, 2.1 and 2.2, levels A and AA. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

interface KnownViolation {
  readonly rule: string;
  readonly page: string;
  readonly theme: string;
  readonly nodes: number;
  /** Why it is still there, or the issue that tracks it. */
  readonly reason: string;
}

function readKnown(file: string): KnownViolation[] {
  const path = join(__dirname, file);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as KnownViolation[]) : [];
}

const KNOWN = [...readKnown("known-violations.json"), ...readKnown("known-violations.extra.json")];

for (const theme of THEMES) {
  for (const anonymous of [false, true]) {
    test.describe(`${theme} theme${anonymous ? ", without a session" : ""}`, () => {
      test.use({ theme });
      if (anonymous) test.use({ storageState: { cookies: [], origins: [] } });

      for (const entry of catalogPages().filter((p) => p.anonymous === anonymous)) {
        test(`a11y ${entry.path}`, async ({ page }) => {
          await openSettled(page, entry.path);
          const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

          const found = new Map(result.violations.map((v) => [v.id, v]));
          const known = KNOWN.filter((k) => k.page === entry.path && k.theme === theme);

          const regressions = result.violations
            .filter((v) => v.nodes.length > (known.find((k) => k.rule === v.id)?.nodes ?? 0))
            .map((v) => ({
              rule: v.id,
              impact: v.impact,
              help: v.help,
              nodes: v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1]?.trim() ?? ""}`),
            }));
          expect(regressions, `new accessibility violations on ${entry.path} (${theme})`).toEqual([]);

          const fixed = known
            .filter((k) => (found.get(k.rule)?.nodes.length ?? 0) < k.nodes)
            .map((k) => `${k.rule}: listed ${k.nodes}, found ${found.get(k.rule)?.nodes.length ?? 0}`);
          expect(fixed, "fewer violations than known-violations.json lists: lower or remove the entry").toEqual([]);
        });
      }
    });
  }
}
