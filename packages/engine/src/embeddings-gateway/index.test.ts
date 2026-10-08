// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
const oa = vi.fn(); const oaMany = vi.fn(); const br = vi.fn(); const brMany = vi.fn();
vi.mock("./providers/openai.js", () => ({ embedOpenAI: (...a: unknown[]) => oa(...a), embedManyOpenAI: (...a: unknown[]) => oaMany(...a) }));
vi.mock("./providers/bedrock.js", () => ({ embedBedrock: (...a: unknown[]) => br(...a), embedManyBedrock: (...a: unknown[]) => brMany(...a) }));
vi.mock("./provider-resolver.js", () => ({ resolveEmbeddingContext: vi.fn() }));
vi.mock("../ai-gateway/logger.js", () => ({ aiLogger: { log: vi.fn(), createEntry: vi.fn((...a: unknown[]) => a) } }));
import { embed, embedMany } from "./index.js";
import { aiLogger } from "../ai-gateway/logger.js";
beforeEach(() => {
  oa.mockReset().mockResolvedValue({ embeddings: [[1]], tokens: 5 });
  br.mockReset().mockResolvedValue({ embeddings: [[2]], tokens: 7 });
  vi.mocked(aiLogger.log).mockClear();
  vi.mocked(aiLogger.createEntry).mockClear();
});
describe("embed dispatch", () => {
  it("routes openai", async () => {
    await embed("x", { providerName: "openai", credentials: { provider: "openai", apiKey: "k" }, dimensions: 1024 });
    expect(oa).toHaveBeenCalled(); expect(br).not.toHaveBeenCalled();
  });
  it("routes bedrock", async () => {
    await embed("x", { providerName: "bedrock", credentials: { provider: "bedrock", region: "eu-west-1" }, dimensions: 1024 });
    expect(br).toHaveBeenCalled();
  });
  it("forwards the Bedrock API key to the bedrock embedder", async () => {
    await embed("x", { providerName: "bedrock", credentials: { provider: "bedrock", apiKey: "bearer-token", region: "eu-west-1" }, dimensions: 1024 });
    expect(br).toHaveBeenCalledWith("x", expect.objectContaining({ apiKey: "bearer-token", region: "eu-west-1" }));
  });
  it("forwards the Bedrock API key on the batch path too", async () => {
    brMany.mockReset().mockResolvedValue({ embeddings: [[2], [3]], tokens: 9 });
    await embedMany(["x", "y"], { providerName: "bedrock", credentials: { provider: "bedrock", apiKey: "bearer-token", region: "eu-west-1" }, dimensions: 1024 });
    expect(brMany).toHaveBeenCalledWith(["x", "y"], expect.objectContaining({ apiKey: "bearer-token", region: "eu-west-1" }));
  });
});

describe("embedding calls are logged as their agent's embedding calls", () => {
  // They reach the provider outside the chat gateway, so without this row the
  // knowledge base and memory were billed and missing from every cost total.
  it("logs the billed tokens at the embedder's price, under the agent's slug", async () => {
    oaMany.mockReset().mockResolvedValue({ embeddings: [[1], [2]], tokens: 1_000_000 });
    const out = await embedMany(["a", "b"], { providerName: "openai", credentials: { provider: "openai", apiKey: "k" }, dimensions: 1024, instanceSlug: "support" });

    expect(out).toEqual([[1], [2]]);
    const entry = vi.mocked(aiLogger.createEntry).mock.calls.at(-1)!;
    expect(entry[0]).toBe("openai");
    expect(entry[1]).toBe("text-embedding-3-small");
    expect(entry[4]).toBe(1_000_000);
    expect(entry[7]).toBeCloseTo(0.02, 12);
    expect(entry[12]).toBe("support");
    expect(entry[13]).toBe("embedding");
    expect(aiLogger.log).toHaveBeenCalledTimes(1);
  });

  it("prices Titan at the Milan rate", async () => {
    await embed("x", { providerName: "bedrock", credentials: { provider: "bedrock", region: "eu-south-1" }, dimensions: 1024, instanceSlug: "support" });
    const entry = vi.mocked(aiLogger.createEntry).mock.calls.at(-1)!;
    expect(entry[1]).toBe("amazon.titan-embed-text-v2:0");
    expect(entry[7]).toBeCloseTo((7 * 0.023) / 1e6, 15);
  });

  it("logs nothing for a call made for no agent", async () => {
    await embed("x", { providerName: "openai", credentials: { provider: "openai", apiKey: "k" }, dimensions: 1024 });
    expect(aiLogger.log).not.toHaveBeenCalled();
  });
});
