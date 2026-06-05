// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";

vi.mock("../../instances/secrets.store.js", () => ({
  getAllSecrets: vi.fn(),
}));
vi.mock("../../memory/embedder.js", () => ({
  generateEmbeddings: vi.fn(),
}));
vi.mock("../../memory/memory-store.js", () => ({
  searchMemories: vi.fn(),
  deleteAllMemories: vi.fn(),
  upsertMemory: vi.fn(),
  deleteMemoryForInstance: vi.fn(),
}));

import { MemoriesController } from "./memories.controller.js";
import { getAllSecrets } from "../../instances/secrets.store.js";
import { generateEmbeddings } from "../../memory/embedder.js";
import { upsertMemory } from "../../memory/memory-store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

describe("MemoriesController.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the OpenAI key via the slug-keyed secrets lookup and creates the memory", async () => {
    // Regression guard for the slug-vs-UUID bug: the POST /memories handler must
    // resolve secrets with getAllSecrets(slug) — which resolves the slug to the
    // instance UUID internally — NOT getAllSecretsById(slug-cast-as-uuid), which
    // queried instance_secrets by the wrong key and always returned no
    // openai_api_key (causing a spurious 400 on every memory creation).
    vi.mocked(getAllSecrets).mockResolvedValue({ openai_api_key: "sk-test" });
    vi.mocked(generateEmbeddings).mockResolvedValue([[0.1, 0.2, 0.3]]);
    vi.mocked(upsertMemory).mockResolvedValue({ id: "mem-1", content: "hello", event: "ADD" });

    const controller = new MemoriesController();
    const result = await controller.create({ instanceId: "my-assistant", content: "hello" });

    expect(getAllSecrets).toHaveBeenCalledWith(asInstanceSlug("my-assistant"));
    expect(generateEmbeddings).toHaveBeenCalledWith(["hello"], "sk-test");
    expect(upsertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: asInstanceSlug("my-assistant"), content: "hello" }),
    );
    expect(result).toEqual({ memory: { id: "mem-1", content: "hello", event: "ADD" } });
  });

  it("returns 400 when the instance has no OpenAI key", async () => {
    vi.mocked(getAllSecrets).mockResolvedValue({});

    const controller = new MemoriesController();

    await expect(
      controller.create({ instanceId: "my-assistant", content: "hello" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateEmbeddings).not.toHaveBeenCalled();
  });
});
