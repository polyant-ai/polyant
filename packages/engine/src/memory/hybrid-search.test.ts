// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

const mockSearchByVector = vi.fn();
const mockEmbed = vi.fn();
const mockResolveEmbeddingContext = vi.fn();
const mockSearchByKeyword = vi.fn();

vi.mock("./memory-store.js", () => ({
  searchByVector: (...args: unknown[]) => mockSearchByVector(...args),
}));

vi.mock("../embeddings-gateway/index.js", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
  embedMany: (...args: unknown[]) => mockEmbed(...args),
  resolveEmbeddingContext: (...args: unknown[]) => mockResolveEmbeddingContext(...args),
}));

vi.mock("../conversations/index.js", () => ({
  conversationStore: {
    searchByKeyword: (...args: unknown[]) => mockSearchByKeyword(...args),
  },
}));

vi.mock("../config.js", () => ({
  DEFAULT_INSTANCE_ID: "test-default-user",
}));

import { hybridSearch } from "./hybrid-search.js";

function makeVectorResult(id: string, content: string, rank: number) {
  return {
    id,
    instanceId: "user-1",
    content,
    category: "general",
    importance: 5,
    sourceConversationId: null,
    createdAt: new Date(`2025-01-0${rank + 1}T00:00:00Z`),
    updatedAt: new Date(`2025-01-0${rank + 1}T00:00:00Z`),
    similarity: 0.9 - rank * 0.1,
  };
}

function makePgResult(id: string, content: string, rank: number) {
  return {
    id,
    conversationId: "conv-1",
    content,
    role: "user",
    rank: rank + 1,
    createdAt: new Date(`2025-01-0${rank + 1}T00:00:00Z`),
  };
}

describe("hybridSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "user-1",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "k" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns empty array when both backends return empty", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    expect(results).toEqual([]);
  });

  it("returns semantic-only results when keyword is empty", async () => {
    mockSearchByVector.mockResolvedValue([
      makeVectorResult("m1", "Memory one", 0),
      makeVectorResult("m2", "Memory two", 1),
    ]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("memory");
    expect(results[0].content).toBe("Memory one");
    expect(results[1].content).toBe("Memory two");
  });

  it("returns keyword-only results when semantic is empty", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([
      makePgResult("pg1", "Conversation one", 0),
    ]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("conversation");
    expect(results[0].content).toBe("Conversation one");
  });

  it("fuses results from both backends using RRF", async () => {
    mockSearchByVector.mockResolvedValue([
      makeVectorResult("m1", "Alpha", 0),
      makeVectorResult("m2", "Beta", 1),
    ]);
    mockSearchByKeyword.mockResolvedValue([
      makePgResult("pg1", "Gamma", 0),
      makePgResult("pg2", "Delta", 1),
    ]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    expect(results).toHaveLength(4);
    // First items from each backend should have equal score (rank 0 in respective backends)
    expect(results[0].score).toBe(results[1].score);
  });

  it("respects the limit parameter", async () => {
    mockSearchByVector.mockResolvedValue([
      makeVectorResult("m1", "A", 0),
      makeVectorResult("m2", "B", 1),
      makeVectorResult("m3", "C", 2),
    ]);
    mockSearchByKeyword.mockResolvedValue([
      makePgResult("pg1", "D", 0),
      makePgResult("pg2", "E", 1),
    ]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"), 2);
    expect(results).toHaveLength(2);
  });

  it("rounds scores to 4 decimal places", async () => {
    mockSearchByVector.mockResolvedValue([
      makeVectorResult("m1", "A", 0),
    ]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    const scoreStr = results[0].score.toString();
    const decimals = scoreStr.split(".")[1] || "";
    expect(decimals.length).toBeLessThanOrEqual(4);
  });

  it("uses default instanceId when not provided", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([]);

    await hybridSearch("test query");

    expect(mockEmbed).toHaveBeenCalledWith("test query", expect.objectContaining({ dimensions: 1024 }));
    expect(mockSearchByVector).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      "test-default-user",
      expect.any(Number),
      1024,
    );
    expect(mockSearchByKeyword).toHaveBeenCalledWith(
      "test query",
      "test-default-user",
      expect.any(Number),
    );
  });

  it("handles semantic backend error gracefully", async () => {
    mockSearchByVector.mockRejectedValue(new Error("pgvector down"));
    mockSearchByKeyword.mockResolvedValue([
      makePgResult("pg1", "Still works", 0),
    ]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Still works");
  });

  it("handles keyword backend error gracefully", async () => {
    mockSearchByVector.mockResolvedValue([
      makeVectorResult("m1", "Still works", 0),
    ]);
    mockSearchByKeyword.mockRejectedValue(new Error("PG down"));

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Still works");
  });

  it("calculates correct RRF scores with k=60 (1/61 for rank 0)", async () => {
    mockSearchByVector.mockResolvedValue([
      makeVectorResult("m1", "First", 0),
    ]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await hybridSearch("test query", asInstanceSlug("user-1"));
    // RRF score for rank 0 with k=60: 1 / (60 + 0 + 1) = 1/61
    const expectedScore = Math.round((1 / 61) * 10000) / 10000;
    expect(results[0].score).toBe(expectedScore);
  });

  it("fetches at least limit*2 or 20 results from each backend", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([]);

    await hybridSearch("test query", asInstanceSlug("user-1"), 5);
    // fetchLimit = Math.max(5*2, 20) = 20
    expect(mockSearchByVector).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      "user-1",
      20,
      1024,
    );
    expect(mockSearchByKeyword).toHaveBeenCalledWith("test query", "user-1", 20);

    vi.clearAllMocks();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "user-1",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "k" },
    });

    await hybridSearch("test query", asInstanceSlug("user-1"), 15);
    // fetchLimit = Math.max(15*2, 20) = 30
    expect(mockSearchByVector).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      "user-1",
      30,
      1024,
    );
    expect(mockSearchByKeyword).toHaveBeenCalledWith("test query", "user-1", 30);
  });
});
