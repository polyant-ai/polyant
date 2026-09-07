// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { skills, skillVersions } from "../skills/schema.js";
import { importSkillAssignments } from "./skill-assignments.import.js";
import type { ExportInstanceData } from "./export.schema.js";

// importSkillAssignments takes `tx` as a parameter (never imports `db`
// itself), so a minimal fake capturing select()/insert() calls is enough —
// no need to mock the whole database client. Mirrors
// import.service.channels.test.ts / import.service.mcp.test.ts.
interface SkillRow {
  id: string;
  slug: string;
  currentVersionId: string | null;
}

function makeFakeTx(options: {
  skillRows?: SkillRow[];
  versionRowsQueue?: Array<Array<{ id: string }>>;
}) {
  const calls: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const versionRowsQueue = [...(options.versionRowsQueue ?? [])];

  const tx = {
    select: (_fields: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => {
          if (table === skills) {
            calls.push("select:skills");
            return Promise.resolve(options.skillRows ?? []);
          }
          if (table === skillVersions) {
            calls.push("select:skillVersions");
            return {
              limit: (_n: number) => Promise.resolve(versionRowsQueue.shift() ?? []),
            };
          }
          throw new Error(`unexpected table in select().from(): ${String(table)}`);
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        calls.push("insert");
        inserted.push(v);
        return { onConflictDoUpdate: (_opts: unknown) => Promise.resolve() };
      },
    }),
  };
  return { tx: tx as never, inserted, calls };
}

function assignment(overrides: Partial<ExportInstanceData["skills"][number]> = {}): ExportInstanceData["skills"][number] {
  return {
    skillSlug: "researcher",
    enabled: true,
    autoLoad: false,
    pinnedVersion: "1.0.0",
    ...overrides,
  };
}

describe("importSkillAssignments", () => {
  it("returns no warnings and issues NO query at all when the assignment list is empty", async () => {
    const { tx, inserted, calls } = makeFakeTx({});

    const warnings = await importSkillAssignments(tx, "instance-1", []);

    expect(warnings).toEqual([]);
    expect(inserted).toEqual([]);
    // The empty-input guard must return before the skill-map query is issued —
    // this is enforced in the caller, not the per-item helper.
    expect(calls).toEqual([]);
  });

  it("warns missing_skill and skips the insert for an unknown skill slug", async () => {
    const { tx, inserted, calls } = makeFakeTx({ skillRows: [] });

    const warnings = await importSkillAssignments(tx, "instance-1", [
      assignment({ skillSlug: "ghost-skill" }),
    ]);

    expect(warnings).toEqual([
      { type: "missing_skill", message: 'Skill "ghost-skill" not found — skipped' },
    ]);
    expect(inserted).toEqual([]);
    expect(calls).toEqual(["select:skills"]);
  });

  it("warns missing_skill and skips the insert when the skill has no available version", async () => {
    const { tx, inserted } = makeFakeTx({
      skillRows: [{ id: "skill-1", slug: "researcher", currentVersionId: null }],
      versionRowsQueue: [[]], // pinned version not found, and no current version fallback
    });

    const warnings = await importSkillAssignments(tx, "instance-1", [assignment()]);

    expect(warnings).toEqual([
      { type: "missing_skill", message: 'Skill "researcher" has no available version — skipped' },
    ]);
    expect(inserted).toEqual([]);
  });

  it("inserts the pinned version with no warning when it is found, in select-then-insert order", async () => {
    const { tx, inserted, calls } = makeFakeTx({
      skillRows: [{ id: "skill-1", slug: "researcher", currentVersionId: "old-version" }],
      versionRowsQueue: [[{ id: "pinned-version" }]],
    });

    const warnings = await importSkillAssignments(tx, "instance-1", [
      assignment({ enabled: true, autoLoad: true }),
    ]);

    expect(warnings).toEqual([]);
    expect(inserted).toEqual([
      {
        instanceId: "instance-1",
        skillId: "skill-1",
        skillVersionId: "pinned-version",
        enabled: true,
        autoLoad: true,
      },
    ]);
    expect(calls).toEqual(["select:skills", "select:skillVersions", "insert"]);
  });

  it("falls back to the skill's current version with no warning when the pinned version is not found", async () => {
    const { tx, inserted } = makeFakeTx({
      skillRows: [{ id: "skill-1", slug: "researcher", currentVersionId: "current-version" }],
      versionRowsQueue: [[]], // pinned "1.0.0" not found
    });

    const warnings = await importSkillAssignments(tx, "instance-1", [assignment()]);

    expect(warnings).toEqual([]);
    expect(inserted[0]).toMatchObject({ skillVersionId: "current-version" });
  });

  it("processes multiple assignments independently, mixing a warning with a successful insert", async () => {
    const { tx, inserted, calls } = makeFakeTx({
      skillRows: [{ id: "skill-1", slug: "researcher", currentVersionId: "current-version" }],
      versionRowsQueue: [[{ id: "pinned-version" }]],
    });

    const warnings = await importSkillAssignments(tx, "instance-1", [
      assignment({ skillSlug: "unknown-slug" }),
      assignment({ skillSlug: "researcher" }),
    ]);

    expect(warnings).toEqual([
      { type: "missing_skill", message: 'Skill "unknown-slug" not found — skipped' },
    ]);
    expect(inserted).toHaveLength(1);
    // A single batched skill-map query serves BOTH assignments; only the
    // second one reaches the per-item version query + insert.
    expect(calls).toEqual(["select:skills", "select:skillVersions", "insert"]);
  });
});
