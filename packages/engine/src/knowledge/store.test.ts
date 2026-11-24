// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The knowledge store's pure rules: the name a colliding upload gets, and the
 * per-write cap checked before any query. What the writes, chunk storage and
 * vector search do in the database runs in store.integration.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

const { mockTransaction } = vi.hoisted(() => ({ mockTransaction: vi.fn() }));
vi.mock("../database/client.js", () => ({ db: { transaction: mockTransaction } }));

import {
  appendAgentDocument,
  upsertAgentDocument,
  resolveUniqueFilename,
  DocumentSizeExceededError,
  MAX_WRITE_BYTES,
} from "./store.js";

describe("resolveUniqueFilename", () => {
  it("returns the name unchanged when there is no collision", () => {
    expect(resolveUniqueFilename("manuale.txt", new Set())).toBe("manuale.txt");
  });

  it("appends a progressive suffix before the extension on collision", () => {
    expect(resolveUniqueFilename("manuale.txt", new Set(["manuale.txt"]))).toBe("manuale (1).txt");
  });

  it("increments the suffix until the name is free", () => {
    const taken = new Set(["manuale.txt", "manuale (1).txt", "manuale (2).txt"]);
    expect(resolveUniqueFilename("manuale.txt", taken)).toBe("manuale (3).txt");
  });

  it("handles filenames without an extension", () => {
    expect(resolveUniqueFilename("README", new Set(["README"]))).toBe("README (1)");
  });

  it("only treats the final segment as the extension (multi-dot names)", () => {
    expect(resolveUniqueFilename("doc.v2.md", new Set(["doc.v2.md"]))).toBe("doc.v2 (1).md");
  });
});

describe("agent writes over the per-write cap", () => {
  const big = "x".repeat(MAX_WRITE_BYTES + 1);

  it.each([
    ["overwrite", upsertAgentDocument],
    ["append", appendAgentDocument],
  ])("an %s is refused before touching the database", async (_mode, write) => {
    await expect(write({ instanceId: asInstanceSlug("inst-1"), filename: "x.md", content: big })).rejects.toBeInstanceOf(
      DocumentSizeExceededError,
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
