// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEmbed, mockEmbedMany } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockEmbedMany: vi.fn(),
}));

vi.mock("ai", () => ({ embed: mockEmbed, embedMany: mockEmbedMany }));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
}));

import { embedCompatible, embedManyCompatible } from "./openai-compatible.js";
import { registerEmbeddingProvider } from "../registry.js";

const registration = {
  name: "length-test-embedder",
  label: "Length Test Embedder",
  baseURL: "https://example.invalid/v1",
  modelId: "an-embedding-model",
  apiKeySecret: "length_test_embedder_api_key",
  supportedDims: [1024] as const,
};

const opts = { registration, apiKey: "key-123", dimensions: 1024 } as const;
const vector = (length: number) => Array.from({ length }, () => 0.1);

beforeEach(() => {
  registerEmbeddingProvider(registration);
  mockEmbed.mockReset();
  mockEmbedMany.mockReset();
});

describe("the requested vector length is enforced on what comes back", () => {
  // The gap this closes: `assertDimSupported` checks what the REGISTRATION
  // claims, not what the endpoint did. These endpoints serve a Matryoshka model
  // at 1024 on request, and `dimensions` support is documented rather than
  // live-verified — an endpoint that ignores it returns its native 4096 and the
  // AI SDK hands it over without complaint.
  it("passes a correctly-sized single embedding through", async () => {
    mockEmbed.mockResolvedValue({ embedding: vector(1024) });

    await expect(embedCompatible("ciao", opts)).resolves.toHaveLength(1024);
  });

  it("refuses a single embedding of the wrong length, naming the provider and both sizes", async () => {
    mockEmbed.mockResolvedValue({ embedding: vector(4096) });

    await expect(embedCompatible("ciao", opts)).rejects.toThrow(
      /Length Test Embedder returned a 4096-dimension embedding.*1024 was requested/s,
    );
  });

  it("refuses a batch where ANY vector is the wrong length", async () => {
    // One bad row in a batch is the realistic shape of a partial failure, and
    // the whole batch is one document's chunks: letting the good ones through
    // would leave a half-embedded knowledge base reported as ready.
    mockEmbedMany.mockResolvedValue({ embeddings: [vector(1024), vector(4096), vector(1024)] });

    await expect(embedManyCompatible(["a", "b", "c"], opts)).rejects.toThrow(/4096-dimension/);
  });

  it("passes a correctly-sized batch through", async () => {
    mockEmbedMany.mockResolvedValue({ embeddings: [vector(1024), vector(1024)] });

    await expect(embedManyCompatible(["a", "b"], opts)).resolves.toHaveLength(2);
  });

  it("checks the single-text shortcut too", async () => {
    // A one-element batch takes the `embed` path, so the check has to be on both
    // entry points or this call skips it.
    mockEmbed.mockResolvedValue({ embedding: vector(4096) });

    await expect(embedManyCompatible(["only"], opts)).rejects.toThrow(/4096-dimension/);
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  it("returns nothing for an empty batch without calling the provider", async () => {
    await expect(embedManyCompatible([], opts)).resolves.toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });
});
