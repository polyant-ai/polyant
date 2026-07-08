// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createProvider } from "./base.js";

/**
 * Nebius Token Factory — OpenAI-compatible inference API.
 * Serves 60+ open-weight models (DeepSeek, Qwen, GLM, gpt-oss, Llama, Nemotron…)
 * behind the standard /v1/chat/completions contract, with native function
 * calling and reasoning (thinking) surfaced via the `reasoning_content` field.
 *
 * Because the endpoint is OpenAI-compatible we don't ship a bespoke adapter:
 * `@ai-sdk/openai-compatible` maps `reasoning_content` → reasoning blocks, so
 * the shared pipeline (base.ts steps/usage/reasoning + the typed-SSE playground)
 * works unchanged. Hybrid reasoning models (Qwen3.5 & friends) think BY DEFAULT,
 * so the gateway (index.ts resolveCallConfig) drives thinking explicitly via
 * providerOptions.nebius: `reasoningEffort` when ON, and the vLLM chat-template
 * kwarg `chat_template_kwargs.enable_thinking=false` when OFF (reasoning_effort
 * alone does NOT disable it). Both are forwarded verbatim into the request body.
 *
 * Docs: https://docs.tokenfactory.nebius.com — base URL confirmed against the
 * quickstart. `includeUsage` is enabled so streaming reports token usage.
 */
const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

export const NebiusProvider = createProvider("nebius", (modelId, apiKeys) => {
  const apiKey = apiKeys?.nebius;
  if (!apiKey) {
    throw new Error(
      "Nebius API key not configured for this instance. Set it in the admin panel under Settings → AI Provider API Keys.",
    );
  }
  const factory = createOpenAICompatible({
    name: "nebius",
    baseURL: NEBIUS_BASE_URL,
    apiKey,
    includeUsage: true,
  });
  return factory(modelId);
});
