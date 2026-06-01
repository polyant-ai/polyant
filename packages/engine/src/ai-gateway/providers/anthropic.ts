// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAnthropic } from "@ai-sdk/anthropic";
import { createProvider } from "./base.js";

/**
 * Beta header that enables interleaved thinking + tool use across multiple
 * turns. Without it, Anthropic rejects payloads that re-inject signed thinking
 * blocks alongside subsequent tool-call rounds.
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#interleaved-thinking
 */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/**
 * Default budget (in tokens) Anthropic spends on extended-thinking content
 * when `request.thinking === true`. Configurable per call via the request
 * options if/when we expose finer control.
 */
const DEFAULT_THINKING_BUDGET = 5000;

export const AnthropicProvider = createProvider("anthropic", (modelId, apiKeys) => {
  const apiKey = apiKeys?.anthropic;
  if (!apiKey) {
    throw new Error("Anthropic API key not configured for this instance. Set it in the admin panel under Settings → AI Provider API Keys.");
  }
  return createAnthropic({
    apiKey,
    headers: {
      // Always send the interleaved-thinking beta header. The provider ignores
      // it when the model is not thinking-capable and accepts no-op when
      // `request.thinking` is false. This avoids per-call header juggling and
      // keeps multi-turn re-injection always supported.
      "anthropic-beta": INTERLEAVED_THINKING_BETA,
    },
  })(modelId);
});

/**
 * Build the `providerOptions.anthropic` object for a thinking-enabled call.
 * Used by the AI gateway when forwarding requests with `thinking: true`.
 *
 * Returns the budget configuration the SDK forwards to Anthropic; callers
 * merge it into their `providerOptions` map.
 */
export function buildAnthropicThinkingOptions(): { thinking: { type: "enabled"; budgetTokens: number } } {
  return {
    thinking: {
      type: "enabled",
      budgetTokens: DEFAULT_THINKING_BUDGET,
    },
  };
}
