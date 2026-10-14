// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The panel's lists and tab bars have one shape each.
 *
 * Every list page used to pick its own cell padding and every tab bar its own
 * component, so two pages showing the same kind of thing looked like two
 * products. The shapes now live in `components/list-table.tsx` (lists) and
 * `components/layout/chip-tabs.tsx` (tab bars); this test stops a page from
 * drawing its own again.
 *
 * - A table cell or heading carries no padding of its own: rows are as tall as
 *   their content under the table's one padding. A cell spanning the whole row
 *   (`colSpan`: an empty state, an expanded detail) is the exception.
 * - A visible tab bar is `ChipTabs`. shadcn `Tabs` may still switch content with
 *   no bar of its own (the agent page's sections are driven by its rail).
 *
 * The subjects are DISCOVERED: every `.tsx` under `app/` and `components/`
 * except the primitives themselves, so a new page cannot escape by being new.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");
const ROOTS = [join(SRC, "app"), join(SRC, "components")];
const PRIMITIVES = [join(SRC, "components", "ui")];

function sources(): Array<{ file: string; text: string }> {
  return ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
      .map((f) => join(root, f))
      .filter((file) => !PRIMITIVES.some((dir) => file.startsWith(dir)))
      .map((file) => ({ file: relative(SRC, file), text: readFileSync(file, "utf8") })),
  );
}

/** Opening tags of the given components; `=>` inside an attribute is not the tag's end. */
function openingTags(text: string, names: string[]): string[] {
  const pattern = new RegExp(`<(?:${names.join("|")})\\b((?:=>|[^>])*)>`, "g");
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

const PADDING = /\b(?:p|px|py|pt|pb|pl|pr)-[\d.[]/;

describe("UI conventions", () => {
  it("should_find_the_files_it_is_asserting_over", () => {
    // Non-vacuity: a path change would otherwise make the checks pass over nothing.
    const all = sources();
    expect(all.length).toBeGreaterThan(100);
    expect(all.some(({ text }) => openingTags(text, ["TableCell"]).length > 0)).toBe(true);
  });

  it("should_leave_table_cell_padding_to_the_table", () => {
    const offenders = sources().flatMap(({ file, text }) =>
      openingTags(text, ["TableCell", "TableHead", "ListHead"])
        .filter((attributes) => !/\bcolSpan\b/.test(attributes))
        .filter((attributes) => [...attributes.matchAll(/className=(?:"([^"]*)"|\{[^}]*?"([^"]*)")/g)]
          .some((m) => PADDING.test(m[1] ?? m[2] ?? "")))
        .map(() => file),
    );
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("should_draw_every_visible_tab_bar_as_chip_tabs", () => {
    const offenders = sources()
      .filter(({ text }) => /from "@\/components\/ui\/tabs"/.test(text) && /\bTabs(?:List|Trigger)\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
