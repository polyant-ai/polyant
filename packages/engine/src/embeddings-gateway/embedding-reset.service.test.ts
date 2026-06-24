// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDeleteAllMemories,
  mockDeleteAllKnowledge,
  mockTransaction,
  mockUpdate,
  mockSet,
  mockWhere,
} = vi.hoisted(() => {
  const mockWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  // db.transaction(cb) runs the callback with a tx that exposes the same
  // chainable update() the service calls inside the transaction.
  const mockTransaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb({ update: mockUpdate }));
  return {
    mockDeleteAllMemories: vi.fn(),
    mockDeleteAllKnowledge: vi.fn(),
    mockTransaction,
    mockUpdate,
    mockSet,
    mockWhere,
  };
});

vi.mock("../database/client.js", () => ({ db: { transaction: mockTransaction } }));
vi.mock("../instances/schema.js", () => ({ instances: { id: "id", embeddingDim: "embedding_dim" } }));
vi.mock("../memory/memory-store.js", () => ({ deleteAllMemories: mockDeleteAllMemories }));
vi.mock("../knowledge/store.js", () => ({ deleteAllKnowledgeForInstance: mockDeleteAllKnowledge }));

import {
  embeddingProviderChanged,
  resetEmbeddingsForProviderSwitch,
} from "./embedding-reset.service.js";

describe("embeddingProviderChanged", () => {
  it("is true when the embedding provider changes (openai↔bedrock)", () => {
    expect(embeddingProviderChanged({ embeddingProvider: "openai" }, { embeddingProvider: "bedrock" })).toBe(true);
    expect(embeddingProviderChanged({ embeddingProvider: "bedrock" }, { embeddingProvider: "openai" })).toBe(true);
  });

  it("is false when the embedding provider is unchanged (chat LLM may still differ)", () => {
    expect(embeddingProviderChanged({ embeddingProvider: "openai" }, { embeddingProvider: "openai" })).toBe(false);
    expect(embeddingProviderChanged({ embeddingProvider: "bedrock" }, { embeddingProvider: "bedrock" })).toBe(false);
  });
});

describe("resetEmbeddingsForProviderSwitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockResolvedValue(undefined);
    mockSet.mockReturnValue({ where: mockWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ update: mockUpdate }));
  });

  it("deletes memories + knowledge by SLUG (not the UUID) and realigns embedding_dim", async () => {
    mockDeleteAllMemories.mockResolvedValue(7);
    mockDeleteAllKnowledge.mockResolvedValue({ documents: 2, chunks: 11 });

    // Distinct slug + uuid: this is the regression guard. The old signature
    // passed the UUID to slug-keyed deletes, matching zero rows. The deletes
    // MUST receive the slug; only the instances-table update gets the UUID.
    const result = await resetEmbeddingsForProviderSwitch(
      "acme" as never,
      "uuid-123" as never,
      "bedrock",
    );

    // Both deletes run inside the shared transaction (second arg is the tx handle).
    expect(mockDeleteAllMemories).toHaveBeenCalledWith("acme", expect.anything());
    expect(mockDeleteAllKnowledge).toHaveBeenCalledWith("acme", expect.anything());
    // The instances row is updated by UUID, not slug.
    expect(mockWhere).toHaveBeenCalledWith(expect.anything());
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingDim: 1024 }),
    );
    expect(result).toEqual({
      instanceId: "uuid-123",
      memoriesDeleted: 7,
      knowledgeDocumentsDeleted: 2,
      knowledgeChunksDeleted: 11,
      newEmbeddingDim: 1024,
    });
  });

  it("realigns to 1024 for an OpenAI target too (default dim)", async () => {
    mockDeleteAllMemories.mockResolvedValue(0);
    mockDeleteAllKnowledge.mockResolvedValue({ documents: 0, chunks: 0 });

    const result = await resetEmbeddingsForProviderSwitch("inst-2" as never, "uuid-2" as never, "openai");

    expect(result.newEmbeddingDim).toBe(1024);
    expect(mockUpdate).toHaveBeenCalledOnce();
  });
});
