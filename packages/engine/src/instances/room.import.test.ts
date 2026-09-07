// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { importRoom } from "./room.import.js";
import type { ExportInstanceData } from "./export.schema.js";

// importRoom takes `tx` as a parameter (never imports `db` itself), so a
// minimal fake capturing insert() calls is enough. Mirrors
// import.service.channels.test.ts.
function makeFakeTx() {
  const inserted: Array<Record<string, unknown>> = [];
  const conflictSets: Array<Record<string, unknown>> = [];
  const tx = {
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return {
          onConflictDoUpdate: (opts: { target: unknown; set: Record<string, unknown> }) => {
            conflictSets.push(opts.set);
            return Promise.resolve();
          },
        };
      },
    }),
  };
  return { tx: tx as never, inserted, conflictSets };
}

function room(overrides: Partial<NonNullable<ExportInstanceData["room"]>> = {}): NonNullable<ExportInstanceData["room"]> {
  return {
    enabled: true,
    prompt: "Watch the inbox and react to urgent messages.",
    outboundChannel: "telegram",
    outboundTarget: "@ops-channel",
    evalIntervalMinutes: 15,
    ...overrides,
  };
}

describe("importRoom", () => {
  it("inserts the room config with the instance id and every field", async () => {
    const { tx, inserted } = makeFakeTx();

    await importRoom(tx, "instance-1", room());

    expect(inserted).toEqual([
      {
        instanceId: "instance-1",
        enabled: true,
        prompt: "Watch the inbox and react to urgent messages.",
        outboundChannel: "telegram",
        outboundTarget: "@ops-channel",
        evalIntervalMinutes: 15,
      },
    ]);
  });

  it("upserts on conflict with the same field values plus a fresh updatedAt", async () => {
    const { tx, conflictSets } = makeFakeTx();

    await importRoom(tx, "instance-1", room({ enabled: false, outboundChannel: null, outboundTarget: null }));

    expect(conflictSets).toHaveLength(1);
    expect(conflictSets[0]).toMatchObject({
      enabled: false,
      prompt: "Watch the inbox and react to urgent messages.",
      outboundChannel: null,
      outboundTarget: null,
      evalIntervalMinutes: 15,
    });
    expect(conflictSets[0].updatedAt).toBeInstanceOf(Date);
  });
});
