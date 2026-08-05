// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOpenAI } from "@ai-sdk/openai";
import { createProvider } from "./base.js";
import { isThinkingCapable } from "../config.js";


export const OpenAIProvider = createProvider("openai", (modelId, apiKeys) => {
  const apiKey = apiKeys?.openai;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured for this instance. Set it in the admin panel under Settings → AI Provider API Keys.");
  }
  const factory = createOpenAI({ apiKey });

  // Reasoning-capable models (o-series + gpt-5 family) MUST be routed through
  // the OpenAI Responses API when used with reasoning_effort + tools — the
  // legacy /v1/chat/completions endpoint rejects those payloads with:
  //   "Function tools with reasoning_effort are not supported for gpt-5.* in
  //    /v1/chat/completions. Please use /v1/responses instead."
  // The Vercel AI SDK exposes the Responses API via `factory.responses()`.
  if (isThinkingCapable("openai", modelId)) {
    return factory.responses(modelId);
  }

  // v6 removed the factory-level `structuredOutputs` setting and defaults
  // `strictJsonSchema` to true. Our tools use Zod .nullish()/.optional()
  // (incompatible with strict JSON schema), so strict mode is disabled per call
  // via providerOptions.openai.strictJsonSchema=false (see ai-gateway index).
  return factory(modelId);
});

/**
 * Build the `providerOptions.openai` object for a reasoning-enabled call at the
 * requested `level`. The SDK maps `reasoningEffort` → the provider's
 * `reasoning.effort`; non-reasoning models ignore it (and the SDK warns).
 *
 * Reference: https://platform.openai.com/docs/guides/reasoning#reasoning-effort
 */
export function buildOpenAIReasoningOptions(level: string): { reasoningEffort: string } {
  // Forward the level as-is: the gateway (resolveReasoningLevel) has already
  // clamped it to this model's catalog `reasoningLevels` (e.g. gpt-5.x accept
  // `xhigh`, o3 only low/medium/high), so it is always a value the API accepts.
  return { reasoningEffort: level };
}
