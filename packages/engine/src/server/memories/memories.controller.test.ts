// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";

const mockResolveEmbeddingContext = vi.fn();
const mockEmbedMany = vi.fn();

vi.mock("../../embeddings-gateway/index.js", () => ({
  resolveEmbeddingContext: (...args: unknown[]) => mockResolveEmbeddingContext(...args),
  embedMany: (...args: unknown[]) => mockEmbedMany(...args),
}));
vi.mock("../../memory/memory-store.js", () => ({
  searchMemories: vi.fn(),
  deleteAllMemories: vi.fn(),
  upsertMemory: vi.fn(),
  deleteMemoryForInstance: vi.fn(),
}));

import { MemoriesController } from "./memories.controller.js";
import { upsertMemory } from "../../memory/memory-store.js";
import { asAgentSlug } from "../../instances/identifiers.js";

describe("MemoriesController.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the provider-aware context by slug and creates the memory", async () => {
    // Regression guard for the slug-vs-UUID bug: the POST /memories handler must
    // pass the instance slug through to the embeddings gateway, which resolves it
    // to the instance UUID internally — never cast the slug to a UUID directly.
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "my-assistant",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "sk-test" },
    });
    mockEmbedMany.mockResolvedValue([[0.1, 0.2, 0.3]]);
    vi.mocked(upsertMemory).mockResolvedValue({ id: "mem-1", content: "hello", event: "ADD" });

    const controller = new MemoriesController();
    const result = await controller.create({ agentId: "my-assistant", content: "hello" });

    expect(mockResolveEmbeddingContext).toHaveBeenCalledWith(asAgentSlug("my-assistant"));
    expect(mockEmbedMany).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ dimensions: 1024 }),
    );
    expect(upsertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: asAgentSlug("my-assistant"), content: "hello" }),
    );
    expect(result).toEqual({ memory: { id: "mem-1", content: "hello", event: "ADD" } });
  });

  it("returns 400 when the embedding provider is not configured", async () => {
    mockResolveEmbeddingContext.mockRejectedValue(new Error("Embedding provider not configured."));

    const controller = new MemoriesController();

    await expect(
      controller.create({ agentId: "my-assistant", content: "hello" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });
});
