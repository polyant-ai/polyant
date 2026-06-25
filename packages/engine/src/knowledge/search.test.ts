// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asAgentSlug } from "../instances/identifiers.js";

const mockSearchByVector = vi.fn();
const mockSearchByKeyword = vi.fn();
const mockEmbed = vi.fn();
const mockResolveEmbeddingContext = vi.fn();

vi.mock("./store.js", () => ({
  searchByVector: (...args: unknown[]) => mockSearchByVector(...args),
  searchByKeyword: (...args: unknown[]) => mockSearchByKeyword(...args),
}));

vi.mock("../embeddings-gateway/index.js", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
  embedMany: (...args: unknown[]) => mockEmbed(...args),
  resolveEmbeddingContext: (...args: unknown[]) => mockResolveEmbeddingContext(...args),
}));

import { searchKnowledge } from "./search.js";

function makeChunkResult(id: string, content: string, source = "doc.md", chunkIndex = 0) {
  return { id, content, source, chunkIndex, score: 0 };
}

describe("searchKnowledge (hybrid)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "maia",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "k" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns empty array when both backends are empty", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    expect(results).toEqual([]);
  });

  it("returns vector-only results when keyword backend is empty", async () => {
    mockSearchByVector.mockResolvedValue([
      makeChunkResult("c1", "Alpha"),
      makeChunkResult("c2", "Beta"),
    ]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.content)).toEqual(["Alpha", "Beta"]);
  });

  it("returns keyword-only results when vector backend is empty", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([
      makeChunkResult("c1", "Menu della serata", "Menu evento"),
    ]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Menu della serata");
    expect(results[0].source).toBe("Menu evento");
  });

  it("dedups chunks present in both backends and sums their RRF scores", async () => {
    // Same chunk id in both: must appear once with combined RRF score.
    mockSearchByVector.mockResolvedValue([
      makeChunkResult("c1", "shared chunk"),
      makeChunkResult("c2", "vector only"),
    ]);
    mockSearchByKeyword.mockResolvedValue([
      makeChunkResult("c1", "shared chunk"),
      makeChunkResult("c3", "keyword only"),
    ]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    const ids = results.map((r) => r.content);
    expect(ids).toContain("shared chunk");
    expect(ids.filter((c) => c === "shared chunk")).toHaveLength(1);

    const shared = results.find((r) => r.content === "shared chunk")!;
    const vectorOnly = results.find((r) => r.content === "vector only")!;
    // shared = 1/61 + 1/61 = 2/61 ; vector-only = 1/62 → shared must rank higher
    expect(shared.score).toBeGreaterThan(vectorOnly.score);
  });

  it("respects the limit parameter", async () => {
    mockSearchByVector.mockResolvedValue([
      makeChunkResult("c1", "A"),
      makeChunkResult("c2", "B"),
      makeChunkResult("c3", "C"),
    ]);
    mockSearchByKeyword.mockResolvedValue([
      makeChunkResult("c4", "D"),
      makeChunkResult("c5", "E"),
    ]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"), 2);
    expect(results).toHaveLength(2);
  });

  it("uses k=60 RRF formula (1/61 for rank 0)", async () => {
    mockSearchByVector.mockResolvedValue([makeChunkResult("c1", "first")]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    const expected = Math.round((1 / 61) * 10000) / 10000;
    expect(results[0].score).toBe(expected);
  });

  it("rounds scores to 4 decimal places", async () => {
    mockSearchByVector.mockResolvedValue([makeChunkResult("c1", "a")]);
    mockSearchByKeyword.mockResolvedValue([]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    const decimals = results[0].score.toString().split(".")[1] ?? "";
    expect(decimals.length).toBeLessThanOrEqual(4);
  });

  it("survives if the vector backend throws", async () => {
    mockSearchByVector.mockRejectedValue(new Error("pgvector down"));
    mockSearchByKeyword.mockResolvedValue([
      makeChunkResult("c1", "still works"),
    ]);

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("still works");
  });

  it("survives if the keyword backend throws", async () => {
    mockSearchByVector.mockResolvedValue([
      makeChunkResult("c1", "still works"),
    ]);
    mockSearchByKeyword.mockRejectedValue(new Error("FTS down"));

    const results = await searchKnowledge("menu", asAgentSlug("maia"));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("still works");
  });

  it("fetches at least limit*2 or 20 results from each backend", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([]);

    await searchKnowledge("menu", asAgentSlug("maia"), 5);
    expect(mockSearchByVector).toHaveBeenCalledWith([0.1, 0.2, 0.3], "maia", 20, 1024);
    expect(mockSearchByKeyword).toHaveBeenCalledWith("menu", "maia", 20);

    vi.clearAllMocks();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "maia",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "k" },
    });

    await searchKnowledge("menu", asAgentSlug("maia"), 15);
    expect(mockSearchByVector).toHaveBeenCalledWith([0.1, 0.2, 0.3], "maia", 30, 1024);
    expect(mockSearchByKeyword).toHaveBeenCalledWith("menu", "maia", 30);
  });

  it("embeds the query through the provider-aware gateway", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([]);

    await searchKnowledge("menu", asAgentSlug("maia"), 5);
    expect(mockResolveEmbeddingContext).toHaveBeenCalledWith("maia");
    expect(mockEmbed).toHaveBeenCalledWith("menu", expect.objectContaining({ dimensions: 1024 }));
  });

  it("propagates the agentId to both backends", async () => {
    mockSearchByVector.mockResolvedValue([]);
    mockSearchByKeyword.mockResolvedValue([]);

    await searchKnowledge("menu", asAgentSlug("maia"));
    expect(mockSearchByVector).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      "maia",
      expect.any(Number),
      1024,
    );
    expect(mockSearchByKeyword).toHaveBeenCalledWith(
      "menu",
      "maia",
      expect.any(Number),
    );
  });
});
