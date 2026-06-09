// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEmbed = vi.fn();
const mockResolveEmbeddingContext = vi.fn();
const mockUpsertMemory = vi.fn();

vi.mock("../../embeddings-gateway/index.js", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
  embedMany: (...args: unknown[]) => mockEmbed(...args),
  resolveEmbeddingContext: (...args: unknown[]) => mockResolveEmbeddingContext(...args),
}));

vi.mock("../../memory/memory-store.js", () => ({
  upsertMemory: (...args: unknown[]) => mockUpsertMemory(...args),
}));

import "./save-memory.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

const ctx = {
  instanceId: "user-1",
  audit: createMockAudit(),
} as any;

describe("saveMemory", () => {
  const def = getToolRegistry().get("saveMemory")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saveMemory = buildTool(def, ctx) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "user-1",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "k" },
    });
  });

  it("returns a tool with description and parameters", () => {
    expect(saveMemory.description).toBeDefined();
    expect(saveMemory.inputSchema).toBeDefined();
  });

  it("calls embed and upsertMemory with correct args", async () => {
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockUpsertMemory.mockResolvedValue({
      id: "m1",
      content: "I like coffee",
      event: "ADD",
    });

    const result = await saveMemory.execute(
      { content: "I like coffee" },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockEmbed).toHaveBeenCalledWith("I like coffee", expect.objectContaining({ dimensions: 1024 }));
    expect(mockUpsertMemory).toHaveBeenCalledWith({
      instanceId: "user-1",
      content: "I like coffee",
      category: "general",
      importance: 7,
      embedding: [0.1, 0.2, 0.3],
      dimensions: 1024,
      provider: "openai",
    });
    expect(result).toEqual({
      saved: true,
      events: [{ id: "m1", event: "ADD" }],
    });
  });

  it("returns error object on failure without throwing", async () => {
    mockEmbed.mockRejectedValue(new Error("embedding failed"));

    const result = await saveMemory.execute(
      { content: "test" },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({
      saved: false,
      error: "embedding failed",
    });
  });
});