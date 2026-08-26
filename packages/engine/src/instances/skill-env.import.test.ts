// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { importSkillEnv, importSkillEnvOverwrite } from "./skill-env.import.js";
import type { ExportInstanceData } from "./export.schema.js";

type SkillEnvRow = { id: string; instanceId: string; skillSlug: string; key: string; value: string; encrypted: boolean };

function envVar(overrides: Partial<ExportInstanceData["skillEnv"][number]> = {}): ExportInstanceData["skillEnv"][number] {
  return { skillSlug: "researcher", key: "API_KEY", encrypted: false, value: "plain-value", ...overrides };
}

// --- importSkillEnv: insert-only, so a minimal fake capturing insert()
// calls is enough — mirrors import.service.channels.test.ts.
function makeInsertOnlyFakeTx() {
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoUpdate: (_opts: unknown) => Promise.resolve() };
      },
    }),
  };
  return { tx: tx as never, inserted };
}

describe("importSkillEnv", () => {
  it("warns skill_env_required and does NOT insert an encrypted entry", async () => {
    const { tx, inserted } = makeInsertOnlyFakeTx();

    const warnings = await importSkillEnv(tx, "instance-1", [
      envVar({ skillSlug: "researcher", key: "SECRET_TOKEN", encrypted: true, value: undefined }),
    ]);

    expect(warnings).toEqual([
      { type: "skill_env_required", message: 'Skill env "researcher.SECRET_TOKEN" (encrypted) needs to be configured' },
    ]);
    expect(inserted).toEqual([]);
  });

  it("inserts a non-encrypted entry directly with no warning", async () => {
    const { tx, inserted } = makeInsertOnlyFakeTx();

    const warnings = await importSkillEnv(tx, "instance-1", [
      envVar({ skillSlug: "researcher", key: "BASE_URL", encrypted: false, value: "https://api.example.com" }),
    ]);

    expect(warnings).toEqual([]);
    expect(inserted).toEqual([
      { instanceId: "instance-1", skillSlug: "researcher", key: "BASE_URL", value: "https://api.example.com", encrypted: false },
    ]);
  });

  it("defaults a missing non-encrypted value to an empty string", async () => {
    const { tx, inserted } = makeInsertOnlyFakeTx();

    await importSkillEnv(tx, "instance-1", [envVar({ encrypted: false, value: undefined })]);

    expect(inserted[0]).toMatchObject({ value: "" });
  });

  it("processes multiple entries independently, mixing a warning with a successful insert", async () => {
    const { tx, inserted } = makeInsertOnlyFakeTx();

    const warnings = await importSkillEnv(tx, "instance-1", [
      envVar({ skillSlug: "researcher", key: "SECRET_TOKEN", encrypted: true, value: undefined }),
      envVar({ skillSlug: "researcher", key: "BASE_URL", encrypted: false, value: "https://api.example.com" }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ key: "BASE_URL" });
  });
});

// --- importSkillEnvOverwrite: models the DB table as an in-memory array so
// the delete-predicate scope (non-encrypted only) can be verified against
// real row survival, not just that some call happened.
function makeStatefulFakeTx(seedRows: SkillEnvRow[]) {
  let rows = [...seedRows];
  const deleteCalls: number[] = [];
  let deleteCallCount = 0;

  const tx = {
    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => Promise.resolve(rows.filter((r) => !r.encrypted)),
      }),
    }),
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => {
        deleteCallCount += 1;
        deleteCalls.push(deleteCallCount);
        rows = rows.filter((r) => r.encrypted); // delete predicate: non-encrypted only
        return Promise.resolve();
      },
    }),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        rows.push({ id: `new-${rows.length}`, ...(v as Omit<SkillEnvRow, "id">) });
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  };
  return { tx: tx as never, getRows: () => rows, getDeleteCallCount: () => deleteCallCount };
}

describe("importSkillEnvOverwrite", () => {
  it("deletes only non-encrypted rows, leaving an encrypted row intact", async () => {
    const { tx, getRows } = makeStatefulFakeTx([
      { id: "enc-1", instanceId: "instance-1", skillSlug: "researcher", key: "SECRET", value: "cipher", encrypted: true },
      { id: "plain-1", instanceId: "instance-1", skillSlug: "researcher", key: "OLD_URL", value: "old", encrypted: false },
    ]);

    const result = await importSkillEnvOverwrite(tx, "instance-1", [
      envVar({ skillSlug: "researcher", key: "BASE_URL", encrypted: false, value: "new-url" }),
    ]);

    expect(result).toBeUndefined();
    const finalRows = getRows();
    // The encrypted row survives the delete...
    expect(finalRows.find((r) => r.id === "enc-1")).toMatchObject({ encrypted: true, value: "cipher" });
    // ...the old non-encrypted row is gone...
    expect(finalRows.find((r) => r.id === "plain-1")).toBeUndefined();
    // ...and the new non-encrypted value from the bundle was inserted.
    expect(finalRows).toContainEqual(
      expect.objectContaining({ skillSlug: "researcher", key: "BASE_URL", value: "new-url", encrypted: false }),
    );
  });

  it("skips an encrypted entry from the bundle without inserting it", async () => {
    const { tx, getRows } = makeStatefulFakeTx([]);

    await importSkillEnvOverwrite(tx, "instance-1", [
      envVar({ skillSlug: "researcher", key: "SECRET_TOKEN", encrypted: true, value: undefined }),
    ]);

    expect(getRows()).toEqual([]);
  });

  it("does not issue a delete when there are no non-encrypted rows to remove", async () => {
    const { tx, getDeleteCallCount } = makeStatefulFakeTx([
      { id: "enc-1", instanceId: "instance-1", skillSlug: "researcher", key: "SECRET", value: "cipher", encrypted: true },
    ]);

    await importSkillEnvOverwrite(tx, "instance-1", []);

    expect(getDeleteCallCount()).toBe(0);
  });

  it("produces no warnings — importSkillEnvOverwrite is void and caller-warned only", async () => {
    const { tx } = makeStatefulFakeTx([]);

    const result = await importSkillEnvOverwrite(tx, "instance-1", [
      envVar({ skillSlug: "researcher", key: "SECRET_TOKEN", encrypted: true, value: undefined }),
      envVar({ skillSlug: "researcher", key: "BASE_URL", encrypted: false, value: "url" }),
    ]);

    expect(result).toBeUndefined();
  });
});
