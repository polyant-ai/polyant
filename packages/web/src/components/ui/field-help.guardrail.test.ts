// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A field's help text is tied to its control.
 *
 * A `<Label htmlFor>` followed by a help paragraph (`text-muted-foreground` or
 * `text-xs`) with nothing tying the paragraph to the control leaves a screen
 * reader announcing the input without its help. `Field` (`components/ui/field.tsx`)
 * wires `aria-describedby` from the control to `FieldDescription` and `FieldError`,
 * so a form field is built with it. This test fails, listing file:line, for a
 * label whose block holds such a paragraph and no `aria-describedby`.
 *
 * The subjects are DISCOVERED: every `.tsx` under `src/` except tests.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sources(): Array<{ file: string; text: string }> {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => join(SRC, f))
    .map((file) => ({ file: relative(SRC, file), text: readFileSync(file, "utf8") }));
}

const LABEL = /<Label\b[^>]*htmlFor=/;
const HELP = /<p[^>]*(text-muted-foreground|text-xs)[^>]*>/;

/** file:line of every `<Label htmlFor>` whose following block has a help paragraph and no `aria-describedby`. */
function untiedHelp(text: string): number[] {
  const lines = text.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!LABEL.test(line)) return;
    const block = lines.slice(i + 1, i + 14).join("\n").split("<Label")[0];
    if (HELP.test(block) && !block.includes("aria-describedby")) hits.push(i + 1);
  });
  return hits;
}

describe("field help guardrail", () => {
  it("should_find_the_files_it_is_asserting_over", () => {
    // Non-vacuity: a path change would otherwise make the check pass over nothing.
    const all = sources();
    expect(all.length).toBeGreaterThan(100);
    const usingField = all.filter(({ text }) =>
      /import\s*\{[^}]*\bField\b[^}]*\}\s*from\s*"@\/components\/ui\/field"/.test(text),
    );
    expect(usingField.length).toBeGreaterThanOrEqual(20);
  });

  it("should_catch_a_raw_label_and_help_pair", () => {
    const raw = `<div>\n<Label htmlFor="x">X</Label>\n<Input id="x" />\n<p className="text-xs text-muted-foreground">help</p>\n</div>`;
    expect(untiedHelp(raw)).toEqual([2]);
    expect(untiedHelp(raw.replace("<Input", '<Input aria-describedby="h"'))).toEqual([]);
  });

  it("should_tie_every_field_help_to_its_control", () => {
    const offenders = sources().flatMap(({ file, text }) =>
      untiedHelp(text).map((line) => `${file}:${line}`),
    );
    expect(
      offenders,
      `Help text not tied to its control. Build the field with Field, FieldLabel, FieldControl and FieldDescription (components/ui/field):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
