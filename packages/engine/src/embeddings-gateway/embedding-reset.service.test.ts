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
  it("is true for openai↔bedrock (embedding space changes)", () => {
    expect(embeddingProviderChanged({ provider: "openai" }, { provider: "bedrock" })).toBe(true);
    expect(embeddingProviderChanged({ provider: "bedrock" }, { provider: "openai" })).toBe(true);
  });

  it("is false for openai↔anthropic (both embed via openai)", () => {
    expect(embeddingProviderChanged({ provider: "openai" }, { provider: "anthropic" })).toBe(false);
    expect(embeddingProviderChanged({ provider: "anthropic" }, { provider: null })).toBe(false);
  });

  it("is false when the provider is unchanged", () => {
    expect(embeddingProviderChanged({ provider: "bedrock" }, { provider: "bedrock" })).toBe(false);
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

  it("wipes memories + knowledge and realigns embedding_dim to the new provider's default", async () => {
    mockDeleteAllMemories.mockResolvedValue(7);
    mockDeleteAllKnowledge.mockResolvedValue({ documents: 2, chunks: 11 });

    const result = await resetEmbeddingsForProviderSwitch("inst-1", "bedrock");

    // Both deletes run inside the shared transaction (second arg is the tx handle).
    expect(mockDeleteAllMemories).toHaveBeenCalledWith("inst-1", expect.anything());
    expect(mockDeleteAllKnowledge).toHaveBeenCalledWith("inst-1", expect.anything());
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingDim: 1024 }),
    );
    expect(result).toEqual({
      instanceId: "inst-1",
      memoriesDeleted: 7,
      knowledgeDocumentsDeleted: 2,
      knowledgeChunksDeleted: 11,
      newEmbeddingDim: 1024,
    });
  });

  it("realigns to 1024 for an OpenAI target too (default dim)", async () => {
    mockDeleteAllMemories.mockResolvedValue(0);
    mockDeleteAllKnowledge.mockResolvedValue({ documents: 0, chunks: 0 });

    const result = await resetEmbeddingsForProviderSwitch("inst-2", "openai");

    expect(result.newEmbeddingDim).toBe(1024);
    expect(mockUpdate).toHaveBeenCalledOnce();
  });
});
