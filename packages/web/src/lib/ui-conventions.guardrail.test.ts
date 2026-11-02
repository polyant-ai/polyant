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
 * - A badge in a list is the default `Badge`: the size overrides (`text-xs`,
 *   `text-[10px]`, `px-1.5`, `py-0`) made the same status read at four sizes. A
 *   file that draws a list with `ListTable` leaves them off.
 * - A list is `ListTable`: a page that draws a `<Table>` itself is not one (the
 *   dashboard's report tables and the onboarding step are not lists of items and are
 *   named below). A list's search and order go through `useListView`, and the drawer
 *   a row opens is `ListDrawer`, not a `SheetContent` of its own.
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

  it("should_draw_the_badges_of_every_list_at_the_one_size", () => {
    // A list is a file that draws `ListTable` (directly or through `SwitchList`), and the
    // drawers of its items are `ListDrawer`s.
    const lists = sources().filter(({ text }) =>
      /from "@\/components\/(?:list-table|switch-list|list-drawer)"/.test(text),
    );
    // Non-vacuity: the lists are discovered, and there are several of them.
    expect(lists.length).toBeGreaterThan(20);
    const offenders = lists
      .filter(({ text }) =>
        openingTags(text, ["Badge"]).some((attributes) => /\b(?:text-xs|text-\[\d+px\]|px-1\.5|py-0)\b/.test(attributes)),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("should_give_every_side_drawer_the_one_width_the_sheet_primitive_sets", () => {
    // Drawers are as wide as `components/ui/sheet.tsx` says (twice the old `md`); a
    // per-use `max-w-*` is how they drifted apart.
    const offenders = sources()
      .filter(({ text }) => openingTags(text, ["SheetContent"]).some((attributes) => /\bmax-w-/.test(attributes)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("should_draw_every_list_as_a_list_table_and_not_a_table_of_its_own", () => {
    // Report tables that are not lists of items a person manages: the dashboard's
    // per-agent comparison and tool figures, and the onboarding step that shows the model
    // of the new agent.
    const NOT_LISTS = [
      "components/analytics/instance-comparison-table.tsx",
      "components/analytics/tool-table.tsx",
      "components/onboarding/wizard-steps.tsx",
    ];
    const tables = sources().filter(({ text }) => /from "@\/components\/ui\/table"/.test(text));
    // Non-vacuity: the files that use the table primitive are discovered.
    expect(tables.length).toBeGreaterThan(10);
    const offenders = tables
      .filter(({ file }) => !NOT_LISTS.includes(file) && file !== "components/list-table.tsx")
      .filter(({ text }) => !/from "@\/components\/list-table"/.test(text) && !/from "@\/components\/switch-list"/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("should_search_and_order_every_list_through_use_list_view", () => {
    const OWNERS = ["components/list-search.tsx", "components/use-list-view.ts"];
    const offenders = sources()
      .filter(({ file }) => !OWNERS.includes(file))
      .filter(({ text }) => /\bmatchesSearch\(/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("should_open_every_list_item_in_a_list_drawer_and_not_a_sheet_of_its_own", () => {
    // The conversation page's debug and context-store panels are not list items.
    const NOT_LIST_ITEMS = ["components/list-drawer.tsx", "components/messages/debug-sheet.tsx", "components/messages/context-store-sheet.tsx"];
    const offenders = sources()
      .filter(({ file }) => !NOT_LIST_ITEMS.includes(file))
      .filter(({ text }) => openingTags(text, ["SheetContent"]).length > 0)
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("should_draw_the_search_row_of_every_list_through_list_toolbar", () => {
    const offenders = sources()
      .filter(({ file }) => file !== "components/list-search.tsx")
      .filter(({ text }) => /<ListSearch\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("should_draw_the_labels_of_a_list_as_secondary_badges_and_leave_states_to_status_badge", () => {
    // `outline` made the same kind of label read two ways; a state is a StatusBadge.
    const lists = sources().filter(({ text }) =>
      /from "@\/components\/(?:list-table|switch-list|list-drawer)"/.test(text),
    );
    expect(lists.length).toBeGreaterThan(20);
    const offenders = lists
      .filter(({ text }) => openingTags(text, ["Badge"]).some((attributes) => /variant="outline"/.test(attributes)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
