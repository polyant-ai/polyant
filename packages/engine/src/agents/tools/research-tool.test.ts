// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAudit } from "../../test-utils.js";

const mockSearch = vi.fn();
vi.mock("@tavily/core", () => ({
  tavily: vi.fn(() => ({ search: mockSearch })),
}));

import "./web-search.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";

const dummyCtx = {
  instanceId: "test",
  secrets: { tavily_api_key: "test-tavily-key" },
  audit: createMockAudit(),
} as any;

describe("webSearch", () => {
  const def = getToolRegistry().get("webSearch")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webSearch = buildTool(def, dummyCtx) as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct parameter schema", () => {
    expect(webSearch.description).toBeDefined();
    expect(webSearch.inputSchema).toBeDefined();
  });

  it("calls Tavily with correct parameters and maps results", async () => {
    mockSearch.mockResolvedValue({
      results: [
        { title: "Result 1", url: "https://example.com/1", content: "Content 1", score: 0.95 },
        { title: "Result 2", url: "https://example.com/2", content: "Content 2", score: 0.8 },
      ],
    });

    const result = await webSearch.execute(
      { query: "AI news", maxResults: 3, searchDepth: "advanced" },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockSearch).toHaveBeenCalledWith("AI news", {
      maxResults: 3,
      searchDepth: "advanced",
    });
    expect(result.query).toBe("AI news");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: "Result 1",
      url: "https://example.com/1",
      content: "Content 1",
      score: 0.95,
    });
  });

  it("uses defaults when optional params not provided", async () => {
    mockSearch.mockResolvedValue({ results: [] });

    await webSearch.execute(
      { query: "test", maxResults: null, searchDepth: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockSearch).toHaveBeenCalledWith("test", {
      maxResults: 5,
      searchDepth: "basic",
    });
  });

  it("returns error object on failure without throwing", async () => {
    mockSearch.mockRejectedValue(new Error("API rate limited"));

    const result = await webSearch.execute(
      { query: "test", maxResults: null, searchDepth: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({
      query: "test",
      provider: "tavily",
      results: [],
      error: "API rate limited",
    });
  });
});
