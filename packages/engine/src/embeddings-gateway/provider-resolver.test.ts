// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const findInstance = vi.fn();
const getSecrets = vi.fn();
vi.mock("../instances/resolve-instance-id.js", () => ({ findInstanceByIdOrSlug: (...a: unknown[]) => findInstance(...a) }));
vi.mock("../instances/secrets.store.js", () => ({
  getAllSecretsById: (...a: unknown[]) => getSecrets(...a),
  SECRET_KEYS: { OPENAI_API_KEY: "openai_api_key", AWS_REGION: "aws_region", AWS_ACCESS_KEY_ID: "aws_access_key_id", AWS_SECRET_ACCESS_KEY: "aws_secret_access_key" },
}));

import { resolveEmbeddingContext, invalidateAllEmbeddingContexts } from "./provider-resolver.js";

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
    getSecrets.mockResolvedValue({ aws_region: "eu-west-1" });
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
  it("throws on unknown instance", async () => {
    findInstance.mockResolvedValue(undefined);
    await expect(resolveEmbeddingContext("nope")).rejects.toThrow(/not found/);
  });
});
