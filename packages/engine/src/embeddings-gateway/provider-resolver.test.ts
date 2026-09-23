// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const findInstance = vi.fn();
const getSecrets = vi.fn();
vi.mock("../instances/resolve-instance-id.js", () => ({ findInstanceByIdOrSlug: (...a: unknown[]) => findInstance(...a) }));
vi.mock("../instances/secrets.store.js", () => ({
  getAllSecretsById: (...a: unknown[]) => getSecrets(...a),
  SECRET_KEYS: { OPENAI_API_KEY: "openai_api_key", AWS_PROVIDER_REGION: "aws_provider_region", AWS_PROVIDER_ACCESS_KEY_ID: "aws_provider_access_key_id", AWS_PROVIDER_SECRET_ACCESS_KEY: "aws_provider_secret_access_key" },
}));

import { resolveEmbeddingContext, invalidateAllEmbeddingContexts } from "./provider-resolver.js";
import { registerEmbeddingProvider } from "./registry.js";

beforeEach(() => {
  findInstance.mockReset();
  getSecrets.mockReset().mockResolvedValue({});
  invalidateAllEmbeddingContexts();
});

describe("resolveEmbeddingContext", () => {
  it("resolves openai with key", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "openai", embeddingProvider: "openai", embeddingDim: 1536 });
    getSecrets.mockResolvedValue({ openai_api_key: "k" });
    const ctx = await resolveEmbeddingContext("s");
    expect(ctx.credentials).toEqual({ provider: "openai", apiKey: "k" });
    expect(ctx.dimensions).toBe(1536);
  });
  it("throws when openai key missing", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "openai", embeddingProvider: "openai", embeddingDim: 1024 });
    await expect(resolveEmbeddingContext("s")).rejects.toThrow(/OpenAI API key required/);
  });
  it("resolves bedrock with region from secrets", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "bedrock", embeddingProvider: "bedrock", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ aws_provider_region: "eu-west-1" });
    const ctx = await resolveEmbeddingContext("s");
    expect(ctx.credentials.provider).toBe("bedrock");
    expect(ctx.dimensions).toBe(1024);
  });
  it("resolves an openai embedder even when the chat provider is anthropic (decoupled)", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "anthropic", embeddingProvider: "openai", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ openai_api_key: "k" });
    const ctx = await resolveEmbeddingContext("s");
    expect(ctx.credentials.provider).toBe("openai");
  });
  // The two defects this pins, both in the same branch. The OpenAI case used to
  // be a bare `else`, so it answered for ANY name the deployment does not serve —
  // an agent configured for an embedder this deployment does not serve had its
  // data sent to OpenAI, and nothing said so. And `providerName` is what the memory and knowledge rows
  // record; it used to be the transport discriminant, which stamped every
  // registered embedder as `openai-compatible`.
  it("refuses an embedder this deployment does not serve, instead of falling back to OpenAI", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "openai", embeddingProvider: "an-embedder-nobody-serves", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ openai_api_key: "k" });

    await expect(resolveEmbeddingContext("s")).rejects.toThrow(/is not available in this deployment/);
  });

  it("reports the embedder's OWN name for persistence, not the transport it speaks", async () => {
    registerEmbeddingProvider({
      name: "resolver-test-embedder",
      label: "Resolver Test Embedder",
      baseURL: "https://example.invalid/v1",
      modelId: "an-embedding-model",
      apiKeySecret: "resolver_test_embedder_api_key",
      supportedDims: [1024],
    });
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "resolver-test-embedder", embeddingProvider: "resolver-test-embedder", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ resolver_test_embedder_api_key: "k" });

    const ctx = await resolveEmbeddingContext("s");

    expect(ctx.providerName).toBe("resolver-test-embedder");
    expect(ctx.credentials.provider).toBe("openai-compatible");
  });

  it("reports the built-in embedders' own names too", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "bedrock", embeddingProvider: "bedrock", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ aws_provider_region: "eu-west-1" });
    expect((await resolveEmbeddingContext("s")).providerName).toBe("bedrock");

    invalidateAllEmbeddingContexts();
    findInstance.mockResolvedValue({ id: "i2", slug: "s2", provider: "openai", embeddingProvider: "openai", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ openai_api_key: "k" });
    expect((await resolveEmbeddingContext("s2")).providerName).toBe("openai");
  });

  it("throws on unknown instance", async () => {
    findInstance.mockResolvedValue(undefined);
    await expect(resolveEmbeddingContext("nope")).rejects.toThrow(/not found/);
  });
});
