// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { importManualTools } from "./manual-tools.import.js";

// importManualTools takes `tx` as a parameter (never imports `db` itself),
// so a minimal fake capturing select()/insert() calls is enough. Mirrors
// import.service.channels.test.ts.
function makeFakeTx(toolRows: Array<{ id: string; name: string }>) {
  const calls: string[] = [];
  const inserted: Array<Array<Record<string, unknown>>> = [];
  const tx = {
    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => {
          calls.push("select");
          return Promise.resolve(toolRows);
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: Array<Record<string, unknown>>) => {
        calls.push("insert");
        inserted.push(v);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  };
  return { tx: tx as never, calls, inserted };
}

describe("importManualTools", () => {
  it("issues no query at all for an empty tool list — empty-input guard", async () => {
    const { tx, calls, inserted } = makeFakeTx([]);

    const warnings = await importManualTools(tx, "instance-1", []);

    expect(warnings).toEqual([]);
    expect(calls).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("warns missing_tool and skips the insert for every unresolved name", async () => {
    const { tx, inserted } = makeFakeTx([]);

    const warnings = await importManualTools(tx, "instance-1", ["ghost-tool"]);

    expect(warnings).toEqual([{ type: "missing_tool", message: 'Tool "ghost-tool" not found — skipped' }]);
    expect(inserted).toEqual([]);
  });

  it("inserts the resolved tools with source \"manual\" and no warning on the happy path", async () => {
    const { tx, inserted } = makeFakeTx([{ id: "tool-1", name: "webSearch" }]);

    const warnings = await importManualTools(tx, "instance-1", ["webSearch"]);

    expect(warnings).toEqual([]);
    expect(inserted).toEqual([[{ instanceId: "instance-1", toolId: "tool-1", source: "manual" }]]);
  });

  it("mixes a resolved insert with a missing_tool warning, inserting ONLY the resolved tool", async () => {
    const { tx, inserted } = makeFakeTx([{ id: "tool-1", name: "webSearch" }]);

    const warnings = await importManualTools(tx, "instance-1", ["webSearch", "ghost-tool"]);

    expect(warnings).toEqual([{ type: "missing_tool", message: 'Tool "ghost-tool" not found — skipped' }]);
    expect(inserted).toEqual([[{ instanceId: "instance-1", toolId: "tool-1", source: "manual" }]]);
  });

  it("skips the insert call entirely when every requested tool is missing", async () => {
    const { tx, calls, inserted } = makeFakeTx([]);

    await importManualTools(tx, "instance-1", ["ghost-a", "ghost-b"]);

    expect(calls).toEqual(["select"]); // insert never issued
    expect(inserted).toEqual([]);
  });
});
