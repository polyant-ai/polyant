// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { importHooks } from "./hooks.import.js";
import type { ExportInstanceData } from "./export.schema.js";

// importHooks takes `tx` as a parameter (never imports `db` itself), so a
// minimal fake capturing insert() calls is enough. Mirrors
// import.service.channels.test.ts.
function makeFakeTx() {
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
  };
  return { tx: tx as never, inserted };
}

function hook(overrides: Partial<ExportInstanceData["hooks"][number]> = {}): ExportInstanceData["hooks"][number] {
  return {
    event: "message_received",
    actionType: "run_tool",
    actionConfig: { functionName: "logEvent" },
    enabled: true,
    position: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

describe("importHooks", () => {
  it("issues no write for an empty hook list", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importHooks(tx, "instance-1", []);

    expect(result).toBeUndefined();
    expect(inserted).toEqual([]);
  });

  it("inserts a hook with every field mapped, including actionConfig verbatim", async () => {
    const { tx, inserted } = makeFakeTx();

    await importHooks(tx, "instance-1", [
      hook({ event: "conversation_start", actionType: "run_tool", actionConfig: { functionName: "greet" }, enabled: false, position: 2, timeoutMs: 3000 }),
    ]);

    expect(inserted).toEqual([
      {
        instanceId: "instance-1",
        event: "conversation_start",
        actionType: "run_tool",
        actionConfig: { functionName: "greet" },
        enabled: false,
        position: 2,
        timeoutMs: 3000,
      },
    ]);
  });

  it("inserts multiple hooks in array order", async () => {
    const { tx, inserted } = makeFakeTx();

    await importHooks(tx, "instance-1", [
      hook({ position: 0, actionConfig: { functionName: "first" } }),
      hook({ position: 1, actionConfig: { functionName: "second" } }),
    ]);

    expect(inserted.map((v) => (v.actionConfig as { functionName: string }).functionName)).toEqual(["first", "second"]);
  });
});
