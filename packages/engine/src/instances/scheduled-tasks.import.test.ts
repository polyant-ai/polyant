// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { importScheduledTasks } from "./scheduled-tasks.import.js";
import type { ExportInstanceData } from "./export.schema.js";

// importScheduledTasks takes `tx` as a parameter (never imports `db`
// itself), so a minimal fake capturing insert() calls is enough. Mirrors
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

const FUTURE_ONE_SHOT = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function task(
  overrides: Partial<ExportInstanceData["scheduledTasks"][number]> = {},
): ExportInstanceData["scheduledTasks"][number] {
  return {
    name: "Daily digest",
    description: null,
    enabled: true,
    schedule: { type: "one-shot", runAt: FUTURE_ONE_SHOT },
    prompt: "Send the daily digest",
    outboundChannel: "telegram",
    outboundTarget: "@ops",
    keepHistory: true,
    deleteAfterRun: false,
    maxRetries: 3,
    createdBy: "user-1",
    ...overrides,
  };
}

describe("importScheduledTasks", () => {
  it("issues no write for an empty task list", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importScheduledTasks(tx, "instance-slug", []);

    expect(result).toBeUndefined();
    expect(inserted).toEqual([]);
  });

  it("inserts an enabled task with a computed nextRunAt in the future", async () => {
    const { tx, inserted } = makeFakeTx();

    await importScheduledTasks(tx, "instance-slug", [task({ enabled: true })]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      instanceId: "instance-slug",
      name: "Daily digest",
      description: null,
      enabled: true,
      prompt: "Send the daily digest",
      outboundChannel: "telegram",
      outboundTarget: "@ops",
      keepHistory: true,
      deleteAfterRun: false,
      maxRetries: 3,
      createdBy: "user-1",
    });
    expect(inserted[0].nextRunAt).toBeInstanceOf(Date);
    expect((inserted[0].nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("inserts a disabled task with nextRunAt = null, never computing a schedule for it", async () => {
    const { tx, inserted } = makeFakeTx();

    await importScheduledTasks(tx, "instance-slug", [task({ enabled: false })]);

    expect(inserted[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("inserts multiple tasks in array order, using the SLUG (not a uuid) as instanceId", async () => {
    const { tx, inserted } = makeFakeTx();

    await importScheduledTasks(tx, "my-agent-slug", [
      task({ name: "first" }),
      task({ name: "second" }),
    ]);

    expect(inserted.map((v) => v.name)).toEqual(["first", "second"]);
    expect(inserted.every((v) => v.instanceId === "my-agent-slug")).toBe(true);
  });
});
