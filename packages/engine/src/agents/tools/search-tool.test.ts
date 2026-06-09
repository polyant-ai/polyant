// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAudit } from "../../test-utils.js";

const mockHybridSearch = vi.fn();

vi.mock("../../memory/index.js", () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

import "./search-memory.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";

const ctx = {
  instanceId: "user-1",
  audit: createMockAudit(),
} as any;

describe("searchMemory", () => {
  const def = getToolRegistry().get("searchMemory")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const searchMemory = buildTool(def, ctx) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns a tool with description and parameters", () => {
    expect(searchMemory.description).toBeDefined();
    expect(searchMemory.inputSchema).toBeDefined();
  });

  it("calls hybridSearch and maps results", async () => {
    mockHybridSearch.mockResolvedValue([
      { content: "User likes coffee", type: "memory", score: 0.85, source: "m1", createdAt: "2025-01-01T00:00:00Z" },
      { content: "Discussed project X", type: "conversation", score: 0.72, source: "pg1", createdAt: "2025-01-02T00:00:00Z" },
    ]);

    const result = await searchMemory.execute(
      { query: "coffee", limit: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockHybridSearch).toHaveBeenCalledWith("coffee", "user-1", undefined);
    expect(result.found).toBe(2);
    expect(result.results[0]).toEqual({
      content: "User likes coffee",
      type: "memory",
      score: 0.85,
      date: "2025-01-01T00:00:00Z",
    });
  });

  it("passes limit parameter to hybridSearch", async () => {
    mockHybridSearch.mockResolvedValue([]);

    await searchMemory.execute(
      { query: "test", limit: 5 },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockHybridSearch).toHaveBeenCalledWith("test", "user-1", 5);
  });

  it("returns error object on failure without throwing", async () => {
    mockHybridSearch.mockRejectedValue(new Error("search failed"));

    const result = await searchMemory.execute(
      { query: "test", limit: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({
      found: 0,
      results: [],
      error: "search failed",
    });
  });

  it("handles null createdAt gracefully", async () => {
    mockHybridSearch.mockResolvedValue([
      { content: "fact", type: "memory", score: 0.5, source: "m1", createdAt: "" },
    ]);

    const result = await searchMemory.execute(
      { query: "test", limit: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result.results[0].date).toBeNull();
  });
});