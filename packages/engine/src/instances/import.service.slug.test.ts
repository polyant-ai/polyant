// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A malformed slug or an empty name is refused before the import opens a
 * transaction. Where a valid import lands, and a taken slug, run on Postgres in
 * import.service.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTransaction } = vi.hoisted(() => ({ mockTransaction: vi.fn() }));
vi.mock("../database/client.js", () => ({ db: { transaction: mockTransaction } }));

import { importNewInstance } from "./import.service.js";

function makeBundle(slug: string, name = "Agent") {
  return {
    version: "1.1" as const,
    exportedAt: "2026-07-28T00:00:00.000Z",
    type: "instance" as const,
    instance: {
      slug,
      name,
      description: null,
      status: "active",
      provider: "openai",
      model: "gpt-4o",
      memoryEnabled: false,
      knowledgeEnabled: false,
      langsmithEnabled: false,
      authEnabled: false,
      prompts: [],
      skills: [],
      manualTools: [],
      secrets: [],
      channels: [],
      skillEnv: [],
      room: null,
      eventSources: [],
    },
  };
}

describe("importNewInstance slug and name", () => {
  beforeEach(() => {
    mockTransaction.mockReset();
  });

  it.each(["Bad Slug", "-leading", "trailing-", "a/b", "", "x".repeat(101)])(
    "refuses the malformed slug %j before writing anything",
    async (slug) => {
      await expect(importNewInstance(makeBundle(slug))).rejects.toThrow(/Invalid slug/);
      expect(mockTransaction).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty name before writing anything", async () => {
    await expect(importNewInstance(makeBundle("free-agent", "   "))).rejects.toThrow(/name cannot be empty/);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
