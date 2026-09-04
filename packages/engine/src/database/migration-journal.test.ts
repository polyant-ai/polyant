// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

/**
 * Integrity guards on the migration journal.
 *
 * drizzle's migrator decides what to apply by comparing each entry's `when`
 * against the newest already-applied timestamp — NOT by file name. So a journal
 * whose timestamps are out of order is not cosmetic: an entry that sorts before
 * an already-applied one is skipped SILENTLY, with no error and no missing-file
 * warning. The `0074` migration was renumbered by hand to sit after MCP, which
 * is exactly the manoeuvre that produces this, so it gets a test rather than a
 * convention.
 */
describe("migration journal", () => {
  it("should_keep_when_timestamps_strictly_increasing", () => {
    const outOfOrder = journal.entries
      .map((entry, i) => ({ entry, prev: journal.entries[i - 1] }))
      .filter(({ entry, prev }) => prev && entry.when <= prev.when)
      .map(({ entry, prev }) => `${entry.tag} (when=${entry.when}) does not come after ${prev!.tag} (when=${prev!.when})`);

    expect(outOfOrder).toEqual([]);
  });

  it("should_keep_idx_contiguous_and_ordered", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it("should_have_a_sql_file_for_every_entry_and_an_entry_for_every_file", () => {
    const tagged = new Set(journal.entries.map((e) => e.tag));
    const missingFiles = journal.entries
      .map((e) => `${e.tag}.sql`)
      .filter((file) => !existsSync(resolve(migrationsDir, file)));
    const orphanFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => !tagged.has(f.replace(/\.sql$/, "")));

    expect({ missingFiles, orphanFiles }).toEqual({ missingFiles: [], orphanFiles: [] });
  });
});
