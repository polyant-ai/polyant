// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

// Chain proxy helper: await returns resolvedValue, every chained method keeps the chain.
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
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
  mockDb.transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
  return { mockDb };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

import {
  appendAgentDocument,
  upsertAgentDocument,
  insertChunks,
  insertChunksAndFinalize,
  searchByVector,
  DocumentSizeExceededError,
  MAX_DOCUMENT_BYTES,
  MAX_WRITE_BYTES,
  type InsertChunkInput,
} from "./store.js";

beforeEach(() => {
  vi.clearAllMocks();
  // re-install the transaction implementation (clearAllMocks resets it)
  mockDb.transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
});

describe("upsertAgentDocument", () => {
  it("creates a new doc when no existing row is found", async () => {
    mockDb.select.mockReturnValue(createChainMock([])); // SELECT FOR UPDATE returns empty
    mockDb.insert.mockReturnValue(createChainMock([{ id: "doc-new" }])); // INSERT RETURNING id

    const result = await upsertAgentDocument({
      instanceId: "inst-1",
      filename: "a.md",
      content: "hello",
    });

    expect(result).toMatchObject({
      docId: "doc-new",
      created: true,
      sizeBytes: 5,
      rawContent: "hello",
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("updates the existing doc when a row with the same (instance, filename) exists", async () => {
    mockDb.select.mockReturnValue(createChainMock([{ id: "doc-existing" }]));
    mockDb.update.mockReturnValue(createChainMock([]));

    const result = await upsertAgentDocument({
      instanceId: "inst-1",
      filename: "a.md",
      content: "overwrite",
    });

    expect(result).toMatchObject({
      docId: "doc-existing",
      created: false,
      sizeBytes: 9,
      rawContent: "overwrite",
    });
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects input larger than MAX_WRITE_BYTES", async () => {
    const big = "x".repeat(MAX_WRITE_BYTES + 1);
    await expect(
      upsertAgentDocument({ instanceId: "inst-1", filename: "x.md", content: big }),
    ).rejects.toBeInstanceOf(DocumentSizeExceededError);
  });
});

describe("appendAgentDocument", () => {
  it("creates a fresh doc when target does not exist (no separator)", async () => {
    mockDb.select.mockReturnValue(createChainMock([]));
    mockDb.insert.mockReturnValue(createChainMock([{ id: "doc-new" }]));

    const result = await appendAgentDocument({
      instanceId: "inst-1",
      filename: "log.md",
      content: "first",
    });

    expect(result.created).toBe(true);
    expect(result.rawContent).toBe("first");
    expect(result.sizeBytes).toBe(5);
  });

  it("appends with double-newline separator when the doc exists", async () => {
    mockDb.select.mockReturnValue(
      createChainMock([{ id: "doc-1", rawContent: "A" }]),
    );
    mockDb.update.mockReturnValue(createChainMock([]));

    const result = await appendAgentDocument({
      instanceId: "inst-1",
      filename: "log.md",
      content: "B",
    });

    expect(result).toMatchObject({
      docId: "doc-1",
      created: false,
      rawContent: "A\n\nB",
      sizeBytes: 4,
    });
  });

  it("rejects append that would exceed MAX_DOCUMENT_BYTES", async () => {
    const existingLen = MAX_DOCUMENT_BYTES - 10;
    mockDb.select.mockReturnValue(
      createChainMock([{ id: "doc-1", rawContent: "x".repeat(existingLen) }]),
    );

    await expect(
      appendAgentDocument({
        instanceId: "inst-1",
        filename: "big.md",
        content: "x".repeat(100), // 100 bytes + \n\n = 102 → well over the 10-byte headroom
      }),
    ).rejects.toBeInstanceOf(DocumentSizeExceededError);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects a single chunk larger than MAX_WRITE_BYTES", async () => {
    await expect(
      appendAgentDocument({
        instanceId: "inst-1",
        filename: "x.md",
        content: "x".repeat(MAX_WRITE_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(DocumentSizeExceededError);
  });
});

describe("insertChunks", () => {
  const chunk: InsertChunkInput = {
    documentId: "doc-1",
    instanceId: "inst-1",
    content: "hello world",
    embedding: [0.1, 0.2],
    chunkIndex: 0,
  };

  it("inserts a 1536-dim embedding into `embedding`, NULLs `embedding_1024`", async () => {
    const insChain = createChainMock([]);
    mockDb.insert.mockReturnValue(insChain);

    const count = await insertChunks([chunk], 1536, "openai");

    expect(count).toBe(1);
    const values = insChain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(values[0].embedding).toEqual([0.1, 0.2]);
    expect(values[0].embedding1024).toBeNull();
    expect(values[0].embeddingProvider).toBe("openai");
  });

  it("inserts a 1024-dim embedding into `embedding_1024`, NULLs `embedding`", async () => {
    const insChain = createChainMock([]);
    mockDb.insert.mockReturnValue(insChain);

    const count = await insertChunks([{ ...chunk, embedding: [0.3, 0.4] }], 1024, "bedrock");

    expect(count).toBe(1);
    const values = insChain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(values[0].embedding).toBeNull();
    expect(values[0].embedding1024).toEqual([0.3, 0.4]);
    expect(values[0].embeddingProvider).toBe("bedrock");
  });

  it("returns 0 and skips the insert for an empty batch", async () => {
    const count = await insertChunks([], 1024, "bedrock");
    expect(count).toBe(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe("insertChunksAndFinalize", () => {
  const chunk: InsertChunkInput = {
    documentId: "doc-1",
    instanceId: "inst-1",
    content: "hello world",
    embedding: [0.5, 0.6],
    chunkIndex: 0,
  };

  it("inserts chunks through the active column and marks the doc ready", async () => {
    const insChain = createChainMock([]);
    mockDb.insert.mockReturnValue(insChain);
    mockDb.update.mockReturnValue(createChainMock([]));

    const count = await insertChunksAndFinalize("doc-1", [chunk], 1024, "bedrock");

    expect(count).toBe(1);
    const values = insChain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(values[0].embedding).toBeNull();
    expect(values[0].embedding1024).toEqual([0.5, 0.6]);
    expect(values[0].embeddingProvider).toBe("bedrock");
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("marks the doc ready with chunkCount 0 for an empty batch", async () => {
    mockDb.update.mockReturnValue(createChainMock([]));

    const count = await insertChunksAndFinalize("doc-1", [], 1536, "openai");

    expect(count).toBe(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe("searchByVector", () => {
  it("maps distance to a rounded similarity score", async () => {
    mockDb.select.mockReturnValue(
      createChainMock([
        { id: "c1", content: "abc", chunkIndex: 0, filename: "a.md", distance: 0.15 },
      ]),
    );

    const results = await searchByVector([0.1, 0.2], "inst-1", 5, 1024);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "c1", source: "a.md", score: 0.85, chunkIndex: 0 });
  });
});
