// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NebiusProvider } from "./nebius.js";
import { BedrockProvider } from "./bedrock.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";

// An image or file part that carries a URL the provider does not take by
// reference used to be downloaded by the AI SDK on the engine, outside the
// engine's outbound HTTP guard, with no time limit and a 2 GiB size cap, every
// part in parallel. The engine builds its own attachments from bytes, so no
// legitimate path needs that download.
//
// No network: the provider call goes to a stubbed global fetch, and the SDK's
// own download fetch (the undici instance provider-utils resolves) is replaced
// so a download, if one happened, would be recorded rather than sent.
const requireFromUtils = createRequire(createRequire(import.meta.url).resolve("@ai-sdk/provider-utils"));
const sdkUndici = requireFromUtils("undici") as { fetch: typeof fetch };
const originalUndiciFetch = sdkUndici.fetch;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const downloads: string[] = [];
const providerBodies: string[] = [];

beforeAll(() => {
  sdkUndici.fetch = (async (input: unknown) => {
    downloads.push(String(input));
    const text = String(input).endsWith(".txt");
    return new Response(text ? "PAGE" : PNG, { status: 200, headers: { "content-type": text ? "text/plain" : "image/png" } });
  }) as typeof fetch;
});
afterAll(() => {
  sdkUndici.fetch = originalUndiciFetch;
  vi.unstubAllGlobals();
});
beforeEach(() => {
  downloads.length = 0;
  providerBodies.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    providerBodies.push(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
    return new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400, headers: { "content-type": "application/json" } });
  }));
});

function historyWith(part: Record<string, unknown>) {
  return [
    { role: "user" as const, content: [{ type: "text", text: "earlier turn" }, part] },
    { role: "assistant" as const, content: "ok" },
    { role: "user" as const, content: "what was in the picture?" },
  ] as never;
}
const run = (adapter: { chat: (r: never, m: string) => Promise<unknown> }, model: string, apiKeys: Record<string, string>, part: Record<string, unknown>) =>
  adapter.chat({ tier: "standard", messages: historyWith(part), apiKeys, maxRetries: 0 } as never, model).then(() => "ok", (e: unknown) => e);

describe("URLs in message parts are never downloaded by the engine", () => {
  it("refuses an image URL a provider cannot take by reference, without fetching it", async () => {
    const image = { type: "image", image: "https://elsewhere.example/pixel.png" };
    const nebius = await run(NebiusProvider, "Qwen/Qwen3-32B", { nebius: "k" }, image);
    const bedrock = await run(BedrockProvider, "eu.anthropic.claude-haiku-5-5", { bedrock_api_key: "k", bedrock_region: "eu-west-1" }, image);

    expect(downloads).toEqual([]);
    expect(providerBodies).toEqual([]);
    for (const result of [nebius, bedrock]) expect(result).toMatchObject({ name: "AI_DownloadError" });
  });

  it("refuses a file URL whose media type the provider does not take by reference", async () => {
    const part = { type: "file", data: "https://elsewhere.example/page.txt", mediaType: "text/plain" };
    const openai = await run(OpenAIProvider, "gpt-5.4-mini", { openai: "k" }, part);
    const anthropic = await run(AnthropicProvider, "claude-haiku-5-5", { anthropic: "k" }, part);

    expect(downloads).toEqual([]);
    for (const result of [openai, anthropic]) expect(result).toMatchObject({ name: "AI_DownloadError" });
  });

  it("makes no download however many URL parts a history carries", async () => {
    const parts = Array.from({ length: 40 }, (_, i) => ({ type: "image", image: `https://site-${i}.example/big.png` }));
    const history = [{ role: "user", content: parts }, { role: "assistant", content: "ok" }, { role: "user", content: "hi" }];
    await NebiusProvider.chat({ tier: "standard", messages: history, apiKeys: { nebius: "k" }, maxRetries: 0 } as never, "Qwen/Qwen3-32B").catch(() => undefined);

    expect(downloads).toEqual([]);
  });

  it("still forwards an image URL to a provider that fetches it itself", async () => {
    const image = { type: "image", image: "https://elsewhere.example/pixel.png", mediaType: "image/png" };
    await run(OpenAIProvider, "gpt-5.4-mini", { openai: "k" }, image);
    await run(AnthropicProvider, "claude-haiku-5-5", { anthropic: "k" }, image);

    expect(downloads).toEqual([]);
    expect(providerBodies.join("\n")).toContain("https://elsewhere.example/pixel.png");
  });

  it("still sends attachments the engine holds as bytes, and data URLs, inline", async () => {
    await run(NebiusProvider, "Qwen/Qwen3-32B", { nebius: "k" }, { type: "image", image: Buffer.from(PNG), mediaType: "image/png" });
    await run(NebiusProvider, "Qwen/Qwen3-32B", { nebius: "k" }, { type: "image", image: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` });

    expect(downloads).toEqual([]);
    expect(providerBodies).toHaveLength(2);
    for (const body of providerBodies) expect(body).toContain("data:image/png;base64,");
  });
});
