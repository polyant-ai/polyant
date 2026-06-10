// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, selectQueue, updateSpy } = vi.hoisted(() => {
  // FIFO queue of results, one per select() call (batch fetches, then the
  // final remaining-count query).
  const selectQueue: unknown[] = [];
  const updateSpy = vi.fn();

  function makeChain(resolvedValue: unknown) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const self: unknown = new Proxy(chain, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(resolvedValue);
        }
        if (!chain[prop]) {
          chain[prop] = () => self;
        }
        return chain[prop];
      },
    });
    return self;
  }

  const mockDb = {
    select: vi.fn(() => {
      const next = selectQueue.length > 0 ? selectQueue.shift() : [];
      return makeChain(next);
    }),
    update: vi.fn(() => {
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      const self: unknown = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop === "set") {
            return (...args: unknown[]) => {
              updateSpy(...args);
              return self;
            };
          }
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve(undefined);
          }
          if (!chain[prop]) {
            chain[prop] = () => self;
          }
          return chain[prop];
        },
      });
      return self;
    }),
    transaction: vi.fn(),
  };

  return { mockDb, selectQueue, updateSpy };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("../memory/schema.js", () => ({
  memories: {
    id: "id",
    content: "content",
    instanceId: "instance_id",
    embedding: "embedding",
    embedding1024: "embedding_1024",
    embeddingProvider: "embedding_provider",
  },
}));

vi.mock("../knowledge/schema.js", () => ({
  knowledgeChunks: {
    id: "id",
    content: "content",
    instanceId: "instance_id",
    embedding: "embedding",
    embedding1024: "embedding_1024",
    embeddingProvider: "embedding_provider",
  },
}));

vi.mock("../instances/schema.js", () => ({
  instances: { id: "id", embeddingDim: "embedding_dim", updatedAt: "updated_at" },
}));

vi.mock("drizzle-orm", () => {
  const sqlTag = Object.assign(
    (..._args: unknown[]) => ({ type: "sql" }),
    { join: vi.fn(() => ({ type: "sql-join" })) },
  );
  return {
    eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
    and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
    or: vi.fn((...args: unknown[]) => ({ type: "or", args })),
    isNotNull: vi.fn((c: unknown) => ({ type: "isNotNull", c })),
    isNull: vi.fn((c: unknown) => ({ type: "isNull", c })),
    sql: sqlTag,
  };
});

const { embedManyMock, resolveCtxMock } = vi.hoisted(() => ({
  embedManyMock: vi.fn(),
  resolveCtxMock: vi.fn(),
}));

vi.mock("./index.js", () => ({
  embedMany: embedManyMock,
  resolveEmbeddingContext: resolveCtxMock,
}));

import { reEmbedInstance, shouldReEmbedAfterSwitch } from "./re-embed.service.js";

const CTX = {
  instanceId: "inst-1",
  dimensions: 1536 as const,
  credentials: { provider: "bedrock" as const, region: "us-east-1" },
};

describe("reEmbedInstance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    resolveCtxMock.mockResolvedValue(CTX);
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) =>
        fn({ ...mockDb, execute: vi.fn() } as unknown as typeof mockDb),
    );
  });

  // The service now processes TWO tables (memories, then knowledge_chunks) before
  // the post-loop legacy counts. The FIFO select() queue order is therefore:
  //   [memories batches…], [knowledge batches…], memories-count, knowledge-count

  it("should report migrated:0 and flip the dim flag when there are zero legacy rows", async () => {
    selectQueue.push([]); // memories batch → empty, loop breaks
    selectQueue.push([]); // knowledge batch → empty, loop breaks
    selectQueue.push([{ remaining: 0 }]); // memories legacy count
    selectQueue.push([{ remaining: 0 }]); // knowledge legacy count

    const result = await reEmbedInstance("inst-1");

    expect(result).toEqual({
      instanceId: "inst-1",
      migrated: 0,
      failed: 0,
      dimFlipped: true,
    });
    expect(embedManyMock).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("should increment failed and NOT flip the flag when a batch throws and legacy rows remain", async () => {
    // memories: one batch with a single row (throws), then drains
    selectQueue.push([{ id: "11111111-1111-1111-1111-111111111111", content: "hello" }]);
    selectQueue.push([]);
    selectQueue.push([]); // knowledge: nothing to migrate
    selectQueue.push([{ remaining: 1 }]); // memories legacy count still > 0
    selectQueue.push([{ remaining: 0 }]); // knowledge legacy count

    embedManyMock.mockRejectedValueOnce(new Error("provider exploded"));

    const result = await reEmbedInstance("inst-1");

    expect(result.failed).toBe(1);
    expect(result.migrated).toBe(0);
    expect(result.dimFlipped).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("should flip the flag only when the post-loop remaining count is 0", async () => {
    // memories: one successful batch, then drains
    selectQueue.push([{ id: "22222222-2222-2222-2222-222222222222", content: "world" }]);
    selectQueue.push([]);
    selectQueue.push([]); // knowledge: nothing to migrate
    selectQueue.push([{ remaining: 0 }]); // memories legacy count
    selectQueue.push([{ remaining: 0 }]); // knowledge legacy count

    embedManyMock.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);

    const result = await reEmbedInstance("inst-1");

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dimFlipped).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("should re-embed same-dim rows produced by a different provider on a same-dimension switch", async () => {
    // The instance is already on 1024 (no legacy rows), but it switched provider
    // (target = bedrock). One memory row still carries another provider's 1024
    // vector and must be re-embedded in place.
    selectQueue.push([{ id: "33333333-3333-3333-3333-333333333333", content: "stale-provider memory" }]);
    selectQueue.push([]); // memories drained after the in-place UPDATE
    selectQueue.push([]); // knowledge: nothing to migrate
    selectQueue.push([{ remaining: 0 }]); // memories legacy count
    selectQueue.push([{ remaining: 0 }]); // knowledge legacy count

    embedManyMock.mockResolvedValueOnce([[0.4, 0.5, 0.6]]);

    const result = await reEmbedInstance("inst-1");

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dimFlipped).toBe(true);
    expect(embedManyMock).toHaveBeenCalledTimes(1);
    // The bulk UPDATE writes embedding_provider = target (bedrock) for the row.
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  it("should migrate knowledge_chunks even when there are no memories", async () => {
    selectQueue.push([]); // memories: nothing to migrate
    // knowledge: one legacy chunk, then drains after the UPDATE
    selectQueue.push([{ id: "44444444-4444-4444-4444-444444444444", content: "legacy chunk" }]);
    selectQueue.push([]);
    selectQueue.push([{ remaining: 0 }]); // memories legacy count
    selectQueue.push([{ remaining: 0 }]); // knowledge legacy count

    embedManyMock.mockResolvedValueOnce([[0.7, 0.8, 0.9]]);

    const result = await reEmbedInstance("inst-1");

    expect(result.migrated).toBe(1);
    expect(result.dimFlipped).toBe(true);
    expect(embedManyMock).toHaveBeenCalledTimes(1);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  it("should NOT flip the dim flag while legacy knowledge_chunks remain (finding 1: 0 memories must not flip early)", async () => {
    selectQueue.push([]); // memories: none
    // knowledge: one legacy chunk whose re-embed FAILS, leaving it on `embedding`
    selectQueue.push([{ id: "55555555-5555-5555-5555-555555555555", content: "stuck chunk" }]);
    selectQueue.push([]);
    selectQueue.push([{ remaining: 0 }]); // memories legacy count → 0
    selectQueue.push([{ remaining: 1 }]); // knowledge legacy count → 1 (blocks flip)

    embedManyMock.mockRejectedValueOnce(new Error("provider exploded"));

    const result = await reEmbedInstance("inst-1");

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.dimFlipped).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("shouldReEmbedAfterSwitch", () => {
  it("triggers when the embedding provider changes (openai → bedrock)", () => {
    expect(shouldReEmbedAfterSwitch({ provider: "openai" }, { provider: "bedrock", embeddingDim: 1024 })).toBe(true);
  });

  it("triggers when the current dim is unsupported by the new provider (bedrock + 1536)", () => {
    expect(shouldReEmbedAfterSwitch({ provider: "openai" }, { provider: "bedrock", embeddingDim: 1536 })).toBe(true);
  });

  it("does not trigger for an anthropic ↔ openai switch (same embedding provider)", () => {
    expect(shouldReEmbedAfterSwitch({ provider: "anthropic" }, { provider: "openai", embeddingDim: 1536 })).toBe(false);
  });

  it("does not trigger when the provider is unchanged and the dim is supported", () => {
    expect(shouldReEmbedAfterSwitch({ provider: "bedrock" }, { provider: "bedrock", embeddingDim: 1024 })).toBe(false);
  });
});
