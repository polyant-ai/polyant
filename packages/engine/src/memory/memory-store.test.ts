// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

// Chain mock: each chained method returns the chain itself, with the final
// call returning a resolved promise (or the accumulated result).
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        // Make the chain thenable so `await` resolves it
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => self);
      }
      return chain[prop];
    },
  });
  return self;
}

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  // transaction passes the mock db itself as the tx argument
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  return { mockDb };
});

vi.mock("../database/client.js", () => ({
  db: mockDb,
}));

vi.mock("./schema.js", () => ({
  memories: {
    id: "id",
    instanceId: "instance_id",
    content: "content",
    category: "category",
    importance: "importance",
    sourceConversationId: "source_conversation_id",
    embedding: "embedding",
    embedding1024: "embedding_1024",
    embeddingProvider: "embedding_provider",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));

// Mock drizzle-orm functions used by memory-store
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  desc: vi.fn((col: unknown) => ({ type: "desc", col })),
  sql: Object.assign(vi.fn(), {
    raw: vi.fn(),
  }),
  gt: vi.fn((...args: unknown[]) => ({ type: "gt", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  isNotNull: vi.fn((c: unknown) => ({ type: "isNotNull", c })),
  ilike: vi.fn((...args: unknown[]) => ({ type: "ilike", args })),
  count: vi.fn(() => ({ type: "count" })),
}));

vi.mock("drizzle-orm/sql/functions", () => ({
  cosineDistance: vi.fn(() => "mock-cosine-distance"),
}));

import {
  upsertMemory,
  searchByVector,
  getAllMemories,
  deleteMemoryForInstance,
  deleteAllMemories,
  countMemories,
} from "./memory-store.js";

describe("memory-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("upsertMemory", () => {
    it("inserts when no duplicate found", async () => {
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);
      const insChain = createChainMock([{ id: "new-id" }]);
      mockDb.insert.mockReturnValue(insChain as any);

      const result = await upsertMemory({
        instanceId: asInstanceSlug("user-1"),
        content: "User likes pizza",
        category: "preference",
        importance: 8,
        embedding: [0.1, 0.2],
        dimensions: 1536,
        provider: "openai",
      });

      expect(result).toEqual({
        id: "new-id",
        content: "User likes pizza",
        event: "ADD",
      });
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("inserts 1536-dim embedding into `embedding`, nulls `embedding_1024`", async () => {
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);
      const insChain = createChainMock([{ id: "new-id" }]);
      mockDb.insert.mockReturnValue(insChain as any);

      await upsertMemory({
        instanceId: asInstanceSlug("user-1"),
        content: "User likes pizza",
        embedding: [0.1, 0.2],
        dimensions: 1536,
        provider: "openai",
      });

      const values = insChain.values.mock.calls[0][0];
      expect(values.embedding).toEqual([0.1, 0.2]);
      expect(values.embedding1024).toBeNull();
      expect(values.embeddingProvider).toBe("openai");
    });

    it("inserts 1024-dim embedding into `embedding_1024`, nulls `embedding`", async () => {
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);
      const insChain = createChainMock([{ id: "new-id" }]);
      mockDb.insert.mockReturnValue(insChain as any);

      await upsertMemory({
        instanceId: asInstanceSlug("user-1"),
        content: "User likes pizza",
        embedding: [0.3, 0.4],
        dimensions: 1024,
        provider: "bedrock",
      });

      const values = insChain.values.mock.calls[0][0];
      expect(values.embedding).toBeNull();
      expect(values.embedding1024).toEqual([0.3, 0.4]);
      expect(values.embeddingProvider).toBe("bedrock");
    });

    it("updates when near-duplicate exists", async () => {
      const selChain = createChainMock([
        { id: "existing-id", content: "User likes pasta", distance: 0.05 },
      ]);
      mockDb.select.mockReturnValue(selChain as any);

      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);

      const result = await upsertMemory({
        instanceId: asInstanceSlug("user-1"),
        content: "User likes pizza",
        embedding: [0.1, 0.2],
        dimensions: 1536,
        provider: "openai",
      });

      expect(result).toEqual({
        id: "existing-id",
        content: "User likes pizza",
        event: "UPDATE",
      });
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("retries on serialization_failure 40001 carried on err.cause (DrizzleQueryError shape)", async () => {
      // 4 retries fail with 40001 nested in `cause`, the 5th succeeds.
      const wrap = (msg: string) => {
        const inner: Error & { code?: string } = new Error("inner");
        inner.code = "40001";
        const outer: Error & { cause?: unknown } = new Error(msg);
        outer.cause = inner;
        return outer;
      };

      mockDb.transaction
        .mockRejectedValueOnce(wrap("fail 1"))
        .mockRejectedValueOnce(wrap("fail 2"))
        .mockRejectedValueOnce(wrap("fail 3"))
        .mockRejectedValueOnce(wrap("fail 4"))
        .mockImplementationOnce(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));

      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);
      const insChain = createChainMock([{ id: "after-retry" }]);
      mockDb.insert.mockReturnValue(insChain as any);

      const result = await upsertMemory({
        instanceId: asInstanceSlug("user-1"),
        content: "Recovered after retries",
        embedding: [0.1, 0.2],
        dimensions: 1536,
        provider: "openai",
      });

      expect(result.id).toBe("after-retry");
      expect(result.event).toBe("ADD");
      expect(mockDb.transaction).toHaveBeenCalledTimes(5);
    });

    it("rethrows non-serialization errors immediately without retry", async () => {
      const fatal: Error & { code?: string } = new Error("permission denied");
      fatal.code = "42501";
      mockDb.transaction.mockRejectedValueOnce(fatal);

      await expect(
        upsertMemory({
          instanceId: asInstanceSlug("user-1"),
          content: "Should fail",
          embedding: [0.1, 0.2],
          dimensions: 1536,
          provider: "openai",
        }),
      ).rejects.toThrow("permission denied");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it("gives up after MAX_UPSERT_RETRIES (5) consecutive 40001 errors", async () => {
      const wrap = () => {
        const inner: Error & { code?: string } = new Error("conflict");
        inner.code = "40001";
        const outer: Error & { cause?: unknown } = new Error("DrizzleQueryError");
        outer.cause = inner;
        return outer;
      };

      mockDb.transaction
        .mockRejectedValueOnce(wrap())
        .mockRejectedValueOnce(wrap())
        .mockRejectedValueOnce(wrap())
        .mockRejectedValueOnce(wrap())
        .mockRejectedValueOnce(wrap());

      await expect(
        upsertMemory({
          instanceId: asInstanceSlug("user-1"),
          content: "Will give up",
          embedding: [0.1, 0.2],
          dimensions: 1536,
          provider: "openai",
        }),
      ).rejects.toThrow("DrizzleQueryError");

      expect(mockDb.transaction).toHaveBeenCalledTimes(5);
    });
  });

  describe("searchByVector", () => {
    it("returns results with similarity", async () => {
      const rows = [
        {
          id: "m1",
          instanceId: "user-1",
          content: "Likes coffee",
          category: "preference",
          importance: 7,
          sourceConversationId: null,
          createdAt: new Date("2025-01-01"),
          updatedAt: new Date("2025-01-01"),
          distance: 0.15,
        },
      ];
      const selChain = createChainMock(rows);
      mockDb.select.mockReturnValue(selChain as any);

      const results = await searchByVector([0.1, 0.2], asInstanceSlug("user-1"), 10, 1024);

      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBe(0.85); // 1 - 0.15
      expect(results[0].content).toBe("Likes coffee");
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("getAllMemories", () => {
    it("returns records for user", async () => {
      const rows = [
        {
          id: "m1",
          instanceId: "user-1",
          content: "Fact A",
          category: "general",
          importance: 5,
          sourceConversationId: null,
          createdAt: new Date("2025-01-01"),
          updatedAt: new Date("2025-01-02"),
        },
      ];
      const selChain = createChainMock(rows);
      mockDb.select.mockReturnValue(selChain as any);

      const results = await getAllMemories(asInstanceSlug("user-1"));

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Fact A");
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("deleteMemoryForInstance", () => {
    it("calls delete with instance scope and returns true when row deleted", async () => {
      const delChain = createChainMock([{ id: "mem-123" }]);
      mockDb.delete.mockReturnValue(delChain as any);

      const result = await deleteMemoryForInstance("mem-123", asInstanceSlug("inst-1"));

      expect(result).toBe(true);
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("returns false when no row matches", async () => {
      const delChain = createChainMock([]);
      mockDb.delete.mockReturnValue(delChain as any);

      const result = await deleteMemoryForInstance("mem-999", asInstanceSlug("inst-1"));

      expect(result).toBe(false);
    });
  });

  describe("deleteAllMemories", () => {
    it("calls delete for user and returns the deleted count", async () => {
      const delChain = createChainMock([{ id: "m1" }, { id: "m2" }]);
      mockDb.delete.mockReturnValue(delChain as any);

      const count = await deleteAllMemories(asInstanceSlug("user-1"));

      expect(mockDb.delete).toHaveBeenCalled();
      expect(count).toBe(2);
    });
  });

  describe("countMemories", () => {
    it("returns the row count for an instance", async () => {
      const selChain = createChainMock([{ count: 5 }]);
      mockDb.select.mockReturnValue(selChain as any);

      const count = await countMemories("user-1");

      expect(count).toBe(5);
    });
  });
});
