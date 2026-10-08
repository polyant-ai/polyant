// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
const oa = vi.fn(); const oaMany = vi.fn(); const br = vi.fn(); const brMany = vi.fn();
vi.mock("./providers/openai.js", () => ({ embedOpenAI: (...a: unknown[]) => oa(...a), embedManyOpenAI: (...a: unknown[]) => oaMany(...a) }));
vi.mock("./providers/bedrock.js", () => ({ embedBedrock: (...a: unknown[]) => br(...a), embedManyBedrock: (...a: unknown[]) => brMany(...a) }));
vi.mock("./provider-resolver.js", () => ({ resolveEmbeddingContext: vi.fn() }));
import { embed, embedMany } from "./index.js";
beforeEach(() => { oa.mockReset().mockResolvedValue([1]); br.mockReset().mockResolvedValue([2]); });
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
    brMany.mockReset().mockResolvedValue([[2], [3]]);
    await embedMany(["x", "y"], { providerName: "bedrock", credentials: { provider: "bedrock", apiKey: "bearer-token", region: "eu-west-1" }, dimensions: 1024 });
    expect(brMany).toHaveBeenCalledWith(["x", "y"], expect.objectContaining({ apiKey: "bearer-token", region: "eu-west-1" }));
  });
});
