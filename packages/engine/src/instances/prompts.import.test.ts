// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { importPrompts } from "./prompts.import.js";
import type { ExportInstanceData } from "./export.schema.js";

// importPrompts takes `tx` as a parameter (never imports `db` itself), so a
// minimal fake capturing insert() calls is enough. Mirrors
// import.service.channels.test.ts.
function makeFakeTx() {
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

function prompt(overrides: Partial<ExportInstanceData["prompts"][number]> = {}): ExportInstanceData["prompts"][number] {
  return { sectionKey: "01-identity", title: "Identity", content: "You are a helpful assistant.", ...overrides };
}

describe("importPrompts", () => {
  it("issues no write for an empty prompt list", async () => {
    const { tx, inserted } = makeFakeTx();

    const result = await importPrompts(tx, "instance-1", []);

    expect(result).toBeUndefined();
    expect(inserted).toEqual([]);
  });

  it("upserts each prompt section with the instance id and content", async () => {
    const { tx, inserted } = makeFakeTx();

    await importPrompts(tx, "instance-1", [
      prompt({ sectionKey: "01-identity", title: "Identity", content: "Body A" }),
      prompt({ sectionKey: "02-tone", title: "Tone", content: "Body B" }),
    ]);

    expect(inserted).toEqual([
      { instanceId: "instance-1", sectionKey: "01-identity", title: "Identity", content: "Body A" },
      { instanceId: "instance-1", sectionKey: "02-tone", title: "Tone", content: "Body B" },
    ]);
  });

  it("drops the legacy 08-datetime section entirely — anti-resurrection guard", async () => {
    const { tx, inserted } = makeFakeTx();

    await importPrompts(tx, "instance-1", [
      prompt({ sectionKey: "08-datetime", title: "Date & time", content: "stale" }),
      prompt({ sectionKey: "01-identity", title: "Identity", content: "kept" }),
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ sectionKey: "01-identity" });
    expect(inserted.some((v) => v.sectionKey === "08-datetime")).toBe(false);
  });
});
