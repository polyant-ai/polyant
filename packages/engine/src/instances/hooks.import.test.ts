// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { importHooks } from "./hooks.import.js";
import { _registerHookForTests, _resetHookRegistryForTests } from "../hooks/hook-registry.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { HookFunctionDefinition } from "@polyant-ai/plugin-sdk";

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

function fakeHookDef(name: string): HookFunctionDefinition {
  return { name, description: "test hook", requiredSecrets: [], handler: () => undefined };
}

function hook(overrides: Partial<ExportInstanceData["hooks"][number]> = {}): ExportInstanceData["hooks"][number] {
  return {
    event: "message_received",
    actionType: "function",
    actionConfig: { functionName: "logEvent" },
    enabled: true,
    position: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

describe("importHooks", () => {
  beforeEach(() => {
    _registerHookForTests(fakeHookDef("logEvent"));
    _registerHookForTests(fakeHookDef("greet"));
    _registerHookForTests(fakeHookDef("first"));
    _registerHookForTests(fakeHookDef("second"));
  });

  afterEach(() => {
    _resetHookRegistryForTests();
  });

  it("issues no write for an empty hook list", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importHooks(tx, "instance-1", []);

    expect(result).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("inserts a hook with every field mapped, including actionConfig verbatim", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importHooks(tx, "instance-1", [
      hook({ event: "conversation_start", actionConfig: { functionName: "greet" }, enabled: false, position: 2, timeoutMs: 3000 }),
    ]);

    expect(result).toEqual([]);
    expect(inserted).toEqual([
      {
        instanceId: "instance-1",
        event: "conversation_start",
        actionType: "function",
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

  // A hand-crafted or cross-version bundle can carry an event/actionType this
  // build doesn't know (export/import round-trip both fields as bare
  // strings), or a functionName that isn't registered. None of that has a DB
  // CHECK constraint, so importHooks must reject it itself — otherwise it
  // silently persists a row that only fails at the first conversation turn,
  // in hook-runner.ts's registry lookup.
  it("skips a hook with an unknown event and warns, without inserting it", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importHooks(tx, "instance-1", [
      hook({ event: "not_a_real_event" as ExportInstanceData["hooks"][number]["event"] }),
    ]);

    expect(inserted).toEqual([]);
    expect(result).toEqual([
      { type: "hook_invalid", message: expect.stringContaining("not_a_real_event") },
    ]);
  });

  it("skips a hook with an unknown actionType and warns, without inserting it", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importHooks(tx, "instance-1", [
      hook({ actionType: "run_tool" as ExportInstanceData["hooks"][number]["actionType"] }),
    ]);

    expect(inserted).toEqual([]);
    expect(result).toEqual([
      { type: "hook_invalid", message: expect.stringContaining("run_tool") },
    ]);
  });

  it("skips a hook whose functionName is not registered and warns, without inserting it", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importHooks(tx, "instance-1", [
      hook({ actionConfig: { functionName: "not-registered" } }),
    ]);

    expect(inserted).toEqual([]);
    expect(result).toEqual([
      { type: "hook_invalid", message: expect.stringContaining("not-registered") },
    ]);
  });

  it("imports valid hooks and skips invalid ones in the same batch, warning only for the invalid one", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importHooks(tx, "instance-1", [
      hook({ actionConfig: { functionName: "logEvent" } }),
      hook({ actionConfig: { functionName: "not-registered" } }),
    ]);

    expect(inserted).toHaveLength(1);
    expect((inserted[0].actionConfig as { functionName: string }).functionName).toBe("logEvent");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("hook_invalid");
  });
});
