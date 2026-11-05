// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { committedSchemaSnapshot, pendingSchemaStatements } from "./schema-snapshot.js";

/**
 * `npm run db:generate` diffs the schema files against the snapshot in
 * migrations/meta. With no snapshot it generated a migration recreating every
 * table; with a stale one it would repeat changes a hand-written migration has
 * already made. A schema change therefore lands with its migration AND a
 * snapshot rewritten by `npm run db:snapshot`.
 */
describe("schema snapshot", () => {
  it("knows every table the schema files declare", () => {
    expect(Object.keys(committedSchemaSnapshot()?.tables ?? {}).length).toBeGreaterThan(40);
  });

  it("matches the schema files, so db:generate writes only a new change", async () => {
    expect(await pendingSchemaStatements()).toEqual([]);
  }, 60_000);
});
