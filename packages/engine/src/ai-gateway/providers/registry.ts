// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChatRequest, ProviderAdapter } from "../types.js";
import { registerProviderConfig, type ProviderConfig } from "../model-catalog.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";
import { NebiusProvider } from "./nebius.js";

/**
 * Which chat provider adapter answers for a provider name, and which instance
 * secret carries its API key.
 *
 * The extension point for a provider that does not ship with the engine — a
 * deployment overlay, a plugin — so it can be added without editing the map every
 * request goes through. Built-in providers are seeded below; anything else is
 * registered at boot.
 *
 * A provider is registered as ONE unit — adapter, catalog, secret key — because
 * a name with only some of the three is a provider that resolves a model it
 * cannot call, or answers a call with no pricing, or authenticates with nothing.
 * `registry.test.ts` pins that.
 */
interface RegisteredProvider {
  readonly adapter: ProviderAdapter;
  /** The `instance_secrets` key holding this provider's API key. */
  readonly apiKeySecret: string;
}

const registry: Record<string, RegisteredProvider> = {
  openai: { adapter: OpenAIProvider, apiKeySecret: "openai_api_key" },
  anthropic: { adapter: AnthropicProvider, apiKeySecret: "anthropic_api_key" },
  // Bedrock authenticates with an API key OR an access-key pair plus a region,
  // resolved by config-resolver on its own; the single-key mapping here is the
  // bearer-token form.
  bedrock: { adapter: BedrockProvider, apiKeySecret: "bedrock_api_key" },
  nebius: { adapter: NebiusProvider, apiKeySecret: "nebius_api_key" },
};

/** The provider names this file owns, captured before any registration runs. */
const BUILT_IN_NAMES: ReadonlySet<string> = new Set(Object.keys(registry));

/**
 * Register a provider at boot: its adapter, its catalog and the secret holding
 * its key. Call it before the first request is served — every gate reads the
 * live registry, so a registration after boot is picked up, but a request
 * served before it would have found no provider by that name.
 *
 * Idempotent, so a double boot (tests, a warm reload) is harmless. Refuses a
 * built-in name: silently shadowing `openai` would re-route every agent that
 * uses it, and move its costs, with nothing in the log.
 */
export function registerAiProvider(provider: {
  name: string;
  adapter: ProviderAdapter;
  config: ProviderConfig;
  apiKeySecret: string;
}): void {
  if (BUILT_IN_NAMES.has(provider.name)) {
    throw new Error(`Cannot register provider "${provider.name}": the name is owned by a built-in provider.`);
  }
  registerProviderConfig(provider.name, provider.config);
  registry[provider.name] = { adapter: provider.adapter, apiKeySecret: provider.apiKeySecret };
}

/** The adapter for a provider name, or `undefined` when nothing serves it. */
export function getProviderAdapter(name: string): ProviderAdapter | undefined {
  return registry[name]?.adapter;
}

/**
 * Every registered provider and the secret key carrying its API key. Read by
 * `config-resolver` so a registered provider's key reaches `ChatRequest.apiKeys`
 * without config-resolver naming it.
 */
export function providerApiKeySecrets(): ReadonlyArray<{ provider: string; secretKey: string }> {
  return Object.entries(registry).map(([provider, { apiKeySecret }]) => ({ provider, secretKey: apiKeySecret }));
}

/**
 * Every REGISTERED provider's API key, under the provider's own name — the
 * fragment `ChatRequest.apiKeys` needs so a provider added at boot is
 * authenticated without the resolver naming it.
 *
 * The built-ins are excluded on purpose: their keys are spelled out where the
 * resolver builds `apiKeys` (typed fields, and Bedrock authenticates with a
 * triple whose fields are not its provider name, so a `bedrock` entry here
 * would be a key nothing reads).
 */
export function registeredProviderApiKeys(
  secrets: Record<string, string>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(registry)
      .filter(([provider]) => !BUILT_IN_NAMES.has(provider))
      .map(([provider, { apiKeySecret }]) => [provider, secrets[apiKeySecret]]),
  );
}

/** Every registered provider name. Used by the registry test and diagnostics. */
export function registeredProviderNames(): readonly string[] {
  return Object.keys(registry);
}

/**
 * A provider's own API key off `ChatRequest.apiKeys`, by provider name.
 *
 * The one place that cast lives. `ChatRequest.apiKeys` is declared closed and
 * under-declares deliberately (an index signature there breaks every tool that
 * forwards `ctx.apiKeys` into its own LLM call, because the plugin SDK's
 * `ToolApiKeys` is an interface), while `config-resolver` fills the object from
 * this registry — so the key IS there at runtime for any registered provider.
 */
export function providerApiKey(
  apiKeys: ChatRequest["apiKeys"],
  provider: string,
): string | undefined {
  return (apiKeys as Record<string, string | undefined> | undefined)?.[provider];
}
