// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  getProviderAdapter,
  providerApiKey,
  providerApiKeySecrets,
  registerAiProvider,
  registeredProviderApiKeys,
  registeredProviderNames,
} from "./registry.js";
import { providerConfigs, type ProviderConfig } from "../model-catalog.js";
import type { ProviderAdapter } from "../types.js";

/** A provider that exists only in this test, so nothing here depends on a shipped one. */
const NAME = "registry-test-provider";
const adapter = { name: NAME, chat: async () => ({}) } as unknown as ProviderAdapter;
const config: ProviderConfig = {
  wireDialect: "openai-compatible",
  tiers: { fast: "m", standard: "m", heavy: "m" },
  models: { m: { input: 1, output: 1, reasoning: false, vision: false, temperature: true, cache: false } },
};

describe("registering a provider", () => {
  it("makes its adapter, its catalog and its key reachable — as one unit", () => {
    // A name with only some of the three is a provider that resolves a model it
    // cannot call, answers a call with no pricing, or authenticates with nothing,
    // and none of those fails loudly on its own.
    registerAiProvider({ name: NAME, adapter, config, apiKeySecret: "registry_test_provider_api_key" });

    expect(getProviderAdapter(NAME)).toBe(adapter);
    expect(providerConfigs[NAME]).toBe(config);
    expect(providerApiKeySecrets()).toContainEqual({
      provider: NAME,
      secretKey: "registry_test_provider_api_key",
    });
    expect(registeredProviderNames()).toContain(NAME);
  });

  it("is idempotent, so a second boot in the same process is harmless", () => {
    expect(() =>
      registerAiProvider({ name: NAME, adapter, config, apiKeySecret: "registry_test_provider_api_key" }),
    ).not.toThrow();
  });

  it("refuses a built-in name rather than silently re-routing it", () => {
    // Shadowing `openai` would move every agent on it, and its costs, with
    // nothing in the log.
    expect(() =>
      registerAiProvider({ name: "openai", adapter, config, apiKeySecret: "x" }),
    ).toThrow(/built-in/);
    expect(getProviderAdapter("openai")?.name).toBe("openai");
  });
});

describe("the keys a registered provider brings", () => {
  it("carries a registered provider's key under its own name, and no built-in", () => {
    // The built-ins are spelled out where `apiKeys` is built (typed fields, and a
    // Bedrock triple whose fields are not its provider name); a `bedrock` entry
    // here would be a key nothing reads.
    registerAiProvider({ name: NAME, adapter, config, apiKeySecret: "registry_test_provider_api_key" });

    const keys = registeredProviderApiKeys({
      registry_test_provider_api_key: "k-registered",
      openai_api_key: "k-openai",
      bedrock_api_key: "k-bedrock",
    });

    expect(keys[NAME]).toBe("k-registered");
    expect(keys).not.toHaveProperty("openai");
    expect(keys).not.toHaveProperty("bedrock");
  });

  it("reads a provider's own key off the request's apiKeys", () => {
    expect(providerApiKey({ [NAME]: "k" } as never, NAME)).toBe("k");
    expect(providerApiKey(undefined, NAME)).toBeUndefined();
  });
});
