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
  embeddingSpaceChanged,
  nextEmbeddingDim,
  resetEmbeddingSpace,
} from "./embedding-reset.service.js";

describe("embeddingSpaceChanged", () => {
  it("is true when the embedding provider changes (openai↔bedrock)", () => {
    expect(
      embeddingSpaceChanged(
        { embeddingProvider: "openai", embeddingDim: 1024 },
        { embeddingProvider: "bedrock", embeddingDim: 1024 },
      ),
    ).toBe(true);
  });

  it("is true when only the dimension changes: 1024 and 1536 vectors are not comparable", () => {
    expect(
      embeddingSpaceChanged(
        { embeddingProvider: "openai", embeddingDim: 1024 },
        { embeddingProvider: "openai", embeddingDim: 1536 },
      ),
    ).toBe(true);
  });

  it("is false when provider and dimension are unchanged (chat LLM may still differ)", () => {
    expect(
      embeddingSpaceChanged(
        { embeddingProvider: "bedrock", embeddingDim: 1024 },
        { embeddingProvider: "bedrock", embeddingDim: 1024 },
      ),
    ).toBe(false);
  });
});

describe("nextEmbeddingDim", () => {
  const stored = { embeddingProvider: "openai", embeddingDim: 1536 };

  it("takes the requested dimension when one is sent", () => {
    expect(nextEmbeddingDim(stored, "openai", 1024)).toBe(1024);
    expect(nextEmbeddingDim(stored, "bedrock", 1024)).toBe(1024);
  });

  it("keeps the stored dimension when the provider is unchanged and none is sent", () => {
    expect(nextEmbeddingDim(stored, "openai", undefined)).toBe(1536);
  });

  it("lands on the new provider's default on a switch with no dimension", () => {
    expect(nextEmbeddingDim(stored, "bedrock", undefined)).toBe(1024);
  });
});

describe("resetEmbeddingSpace", () => {
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
    const result = await resetEmbeddingSpace("acme" as never, "uuid-123" as never, 1024);

    // Both deletes run inside the shared transaction. deleteAllMemories takes a
    // REQUIRED tenant scope before the executor: this service has no principal,
    // so it states the cross-tenant scope and its reason instead of passing
    // `undefined`, which used to be indistinguishable from a forgotten argument.
    expect(mockDeleteAllMemories).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ reason: expect.stringContaining("embedding space change") }),
      expect.anything(),
    );
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

  it("writes the dimension it is given, so a 1536 choice is what future embeds use", async () => {
    mockDeleteAllMemories.mockResolvedValue(0);
    mockDeleteAllKnowledge.mockResolvedValue({ documents: 0, chunks: 0 });

    const result = await resetEmbeddingSpace("inst-2" as never, "uuid-2" as never, 1536);

    expect(result.newEmbeddingDim).toBe(1536);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ embeddingDim: 1536 }));
    expect(mockUpdate).toHaveBeenCalledOnce();
  });
});
