// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BedrockProvider } from "./bedrock.js";
import { embedBedrock } from "../../embeddings-gateway/providers/bedrock.js";
import type { ChatRequest } from "../types.js";

// The real @ai-sdk/amazon-bedrock is used on purpose: the defect lives in how
// it fills an option this code leaves undefined. Only the network is stubbed,
// and the assertion reads the Authorization header the SDK actually sent.
const sentAuthorization: string[] = [];

beforeEach(() => {
  sentAuthorization.length = 0;
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "deployment-bearer");
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sentAuthorization.push(headers.get("authorization") ?? "");
    return new Response(JSON.stringify({ message: "stubbed" }), { status: 400 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const keyPair = {
  bedrock_access_key_id: "AKIAAGENTOWN0000000",
  bedrock_secret_access_key: "agent-own-secret",
  bedrock_region: "eu-west-1",
};

describe("Bedrock authentication with AWS_BEARER_TOKEN_BEDROCK in the environment", () => {
  // An agent that brings its own key pair must be signed with that pair. The
  // SDK fills a missing apiKey from the environment and a bearer token wins
  // over SigV4, so the deployment's token used to sign the agent's calls.
  it("signs a chat call with the agent's own key pair", async () => {
    const request = { messages: [{ role: "user", content: "hi" }], apiKeys: keyPair } as unknown as ChatRequest;
    await BedrockProvider.chat(request, "eu.amazon.nova-pro-v1:0").catch(() => undefined);
    expect(sentAuthorization.length).toBeGreaterThan(0);
    expect(sentAuthorization[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAAGENTOWN0000000\//);
  });

  it("signs an embedding call with the agent's own key pair", async () => {
    await embedBedrock("hi", {
      accessKeyId: keyPair.bedrock_access_key_id,
      secretAccessKey: keyPair.bedrock_secret_access_key,
      region: keyPair.bedrock_region,
      dimensions: 1024,
    }).catch(() => undefined);
    expect(sentAuthorization.length).toBeGreaterThan(0);
    expect(sentAuthorization[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAAGENTOWN0000000\//);
  });
});
