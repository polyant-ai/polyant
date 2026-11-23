// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retry policy of `upsertMemory`: a SERIALIZABLE conflict is retried, any
 * other failure is not, and the retries end. What a save writes, and every read
 * and delete, run on Postgres in memory-store.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

const { mockTransaction } = vi.hoisted(() => ({ mockTransaction: vi.fn() }));

// The transaction is the boundary under test: each attempt is one call.
vi.mock("../database/client.js", () => ({ db: { transaction: mockTransaction } }));
vi.mock("../database/vector-scan.js", () => ({
  completeVectorScanSetting: vi.fn(async () => "SET LOCAL hnsw.iterative_scan = strict_order"),
}));

import { upsertMemory } from "./memory-store.js";

const INPUT = {
  instanceId: asInstanceSlug("user-1"),
  content: "fact",
  embedding: [0.1, 0.2],
  dimensions: 1536 as const,
  provider: "openai" as const,
};

/** A conflict shaped like DrizzleQueryError: the SQLSTATE sits on `cause`. */
function conflict(msg = "DrizzleQueryError"): Error {
  const inner: Error & { code?: string } = new Error("inner");
  inner.code = "40001";
  return Object.assign(new Error(msg), { cause: inner });
}

describe("upsertMemory retries", () => {
  beforeEach(() => {
    mockTransaction.mockReset();
  });

  it("retries a serialization failure carried on err.cause until an attempt succeeds", async () => {
    const saved = { id: "after-retry", content: "fact", event: "ADD" };
    mockTransaction
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce(saved);

    await expect(upsertMemory(INPUT)).resolves.toEqual(saved);
    expect(mockTransaction).toHaveBeenCalledTimes(5);
  });

  it("rethrows any other failure at once", async () => {
    mockTransaction.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "42501" }));

    await expect(upsertMemory(INPUT)).rejects.toThrow("permission denied");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("gives up after five consecutive serialization failures", async () => {
    mockTransaction.mockRejectedValue(conflict("still conflicting"));

    await expect(upsertMemory(INPUT)).rejects.toThrow("still conflicting");
    expect(mockTransaction).toHaveBeenCalledTimes(5);
  });
});
