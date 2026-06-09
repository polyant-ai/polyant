import { describe, it, expect, vi, beforeEach } from "vitest";
const oa = vi.fn(); const oaMany = vi.fn(); const br = vi.fn(); const brMany = vi.fn();
vi.mock("./providers/openai.js", () => ({ embedOpenAI: (...a: unknown[]) => oa(...a), embedManyOpenAI: (...a: unknown[]) => oaMany(...a) }));
vi.mock("./providers/bedrock.js", () => ({ embedBedrock: (...a: unknown[]) => br(...a), embedManyBedrock: (...a: unknown[]) => brMany(...a) }));
vi.mock("./provider-resolver.js", () => ({ resolveEmbeddingContext: vi.fn() }));
import { embed } from "./index.js";
beforeEach(() => { oa.mockReset().mockResolvedValue([1]); br.mockReset().mockResolvedValue([2]); });
describe("embed dispatch", () => {
  it("routes openai", async () => {
    await embed("x", { credentials: { provider: "openai", apiKey: "k" }, dimensions: 1024 });
    expect(oa).toHaveBeenCalled(); expect(br).not.toHaveBeenCalled();
  });
  it("routes bedrock", async () => {
    await embed("x", { credentials: { provider: "bedrock", region: "eu-west-1" }, dimensions: 1024 });
    expect(br).toHaveBeenCalled();
  });
});
