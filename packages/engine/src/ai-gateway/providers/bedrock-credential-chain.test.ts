// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The AWS default credential chain resolves credentials from files and
// metadata endpoints, and memoizes what it found. A chain built per call
// resolves them again on every call.
const { chainsBuilt } = vi.hoisted(() => ({ chainsBuilt: { count: 0 } }));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => {
    chainsBuilt.count += 1;
    return async () => ({ accessKeyId: "AKIADEFAULTCHAIN000", secretAccessKey: "secret" });
  },
}));

const { BedrockProvider } = await import("./bedrock.js");
const { embedBedrock } = await import("../../embeddings-gateway/providers/bedrock.js");
import type { ChatRequest } from "../types.js";

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "stubbed" }), { status: 400 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const noKeys = { bedrock_region: "eu-west-1" };

describe("Bedrock calls without explicit credentials", () => {
  it("reuse one default credential chain across chat calls", async () => {
    const request = { tier: "standard", messages: [{ role: "user", content: "hi" }], apiKeys: noKeys, maxRetries: 0 } as ChatRequest;
    const before = chainsBuilt.count;
    await BedrockProvider.chat(request, "eu.amazon.nova-pro-v1:0").catch(() => undefined);
    await BedrockProvider.chat(request, "eu.amazon.nova-pro-v1:0").catch(() => undefined);
    expect(chainsBuilt.count - before).toBeLessThanOrEqual(1);
  });

  it("reuse one default credential chain across embedding calls", async () => {
    const before = chainsBuilt.count;
    for (let i = 0; i < 2; i++) {
      await embedBedrock("hi", { region: "eu-west-1", dimensions: 1024 }).catch(() => undefined);
    }
    expect(chainsBuilt.count - before).toBeLessThanOrEqual(1);
  });
});
