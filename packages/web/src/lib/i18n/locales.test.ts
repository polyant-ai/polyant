// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract tests for the locale files themselves.
 *
 * `JSON.parse` resolves a duplicated key last-wins and reports nothing, so
 * `"instances.detail.tabSettings"` sat in both files twice — once as "Settings",
 * once as "Model" — and rendered correctly purely by parse order. Anything that
 * reads the file first-wins or normalises it (a formatter, a jsonc linter, an
 * extraction script, `jq -s`) would silently revert the label, and a reviewer
 * reading the file sees whichever line they scroll past first.
 *
 * The duplicate is invisible to a parsed-object comparison, so these tests read
 * the RAW text.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const localesDir = dirname(fileURLToPath(import.meta.url));
const LOCALES = ["en", "it"] as const;

function rawLocale(locale: string): string {
  return readFileSync(resolve(localesDir, "locales", `${locale}.json`), "utf8");
}

/** Every top-level key in source order, duplicates included. */
function declaredKeys(source: string): string[] {
  return [...source.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]);
}

describe("locale files", () => {
  it.each(LOCALES)("%s declares no key twice", (locale) => {
    const keys = declaredKeys(rawLocale(locale));
    const seen = new Set<string>();
    const duplicated = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));

    expect([...new Set(duplicated)]).toEqual([]);
  });

  it("en and it declare the same key set", () => {
    const en = new Set(declaredKeys(rawLocale("en")));
    const it = new Set(declaredKeys(rawLocale("it")));

    // A key in one file only renders as a raw key (or blank) in the other
    // language — a defect nobody sees until they switch locale.
    expect([...en].filter((k) => !it.has(k)), "missing from it.json").toEqual([]);
    expect([...it].filter((k) => !en.has(k)), "missing from en.json").toEqual([]);
  });
});
