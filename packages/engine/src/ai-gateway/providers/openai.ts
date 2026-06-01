// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOpenAI } from "@ai-sdk/openai";
import { createProvider } from "./base.js";
import { isThinkingCapable } from "../config.js";

/**
 * Default reasoning effort for OpenAI o-series / reasoning-capable models when
 * `request.thinking === true`. The SDK forwards this to the provider; non-
 * reasoning models ignore the field.
 *
 * Reference: https://platform.openai.com/docs/guides/reasoning#reasoning-effort
 */
const DEFAULT_REASONING_EFFORT = "medium";

export const OpenAIProvider = createProvider("openai", (modelId, apiKeys) => {
  const apiKey = apiKeys?.openai;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured for this instance. Set it in the admin panel under Settings → AI Provider API Keys.");
  }
  const factory = createOpenAI({ apiKey, compatibility: "strict" });

  // Reasoning-capable models (o-series + gpt-5 family) MUST be routed through
  // the OpenAI Responses API when used with reasoning_effort + tools — the
  // legacy /v1/chat/completions endpoint rejects those payloads with:
  //   "Function tools with reasoning_effort are not supported for gpt-5.* in
  //    /v1/chat/completions. Please use /v1/responses instead."
  // The Vercel AI SDK exposes the Responses API via `factory.responses()`.
  if (isThinkingCapable("openai", modelId)) {
    return factory.responses(modelId);
  }

  return factory(modelId, {
    // Disable structuredOutputs for non-reasoning models with our tool schemas.
    // The SDK defaults structuredOutputs=true for reasoning models, which adds
    // strict:true to tool schemas — requiring ALL properties in `required`.
    // Our tools use Zod .nullish()/.optional() extensively, producing schemas
    // incompatible with OpenAI's strict mode. Disabling this lets the API
    // validate schemas normally while keeping full tool-use support.
    structuredOutputs: false,
  });
});

/**
 * Build the `providerOptions.openai` object for a reasoning-enabled call.
 * Used by the AI gateway when forwarding requests with `thinking: true`.
 *
 * The SDK maps `reasoningEffort` to the provider's `reasoning.effort` field;
 * non-reasoning models silently ignore it.
 */
export function buildOpenAIReasoningOptions(): { reasoningEffort: "low" | "medium" | "high" } {
  return { reasoningEffort: DEFAULT_REASONING_EFFORT };
}
