// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { RENAMED_TOOLS } from "./renamed-tools.js";

/**
 * The migration renames catalog rows; the importer translates old bundles. If
 * the two lists drift, a bundle enables a name the catalog no longer carries,
 * or a database keeps a row the importer would never find.
 */
describe("RENAMED_TOOLS", () => {
  it("lists exactly the pairs migration rename_extracted_tools applies", () => {
    // Found by name, not number: editions number their migrations differently.
    const dir = new URL("../../database/migrations/", import.meta.url);
    const file = readdirSync(dir).find((f) => f.endsWith("_rename_extracted_tools.sql"));
    expect(file).toBeDefined();
    const migration = readFileSync(new URL(file!, dir), "utf8");

    const pairs = [...migration.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]]);

    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs).toEqual([...RENAMED_TOOLS.entries()]);
  });
});
