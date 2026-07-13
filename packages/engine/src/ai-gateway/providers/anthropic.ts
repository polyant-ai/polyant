// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createProvider, type PrepareMessages } from "./base.js";
import { injectCacheBreakpoints, makeStepMarker, withProviderCacheMarker } from "./prompt-caching.js";

/**
 * Beta header that enables interleaved thinking + tool use across multiple
 * turns. Without it, Anthropic rejects payloads that re-inject signed thinking
 * blocks alongside subsequent tool-call rounds.
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#interleaved-thinking
 */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/**
 * Legacy extended-thinking budgets (tokens) per reasoning level, for models on
 * the OLD `thinking.type:"enabled"` API. Newer models (Opus 4.7/4.8, Sonnet 5,
 * Fable 5) use `thinking.type:"adaptive"` + effort instead (see build fn).
 */
const ANTHROPIC_THINKING_BUDGETS: Record<"low" | "medium" | "high", number> = {
  low: 4096,
  medium: 12000,
  high: 24000,
};

/**
 * Anthropic requires an explicit `cache_control` marker (the `@ai-sdk/anthropic`
 * provider adds none), so without this every turn re-pays the full prompt. Two
 * TTLs, selected per instance by `cacheConfig.ttl` (default 1h):
 *  - 1h — best for Polyant's slow async channels (WhatsApp/Telegram): turns
 *    arrive minutes-to-sub-hour apart, so a 5m prefix would expire between turns
 *    and re-pay the write (2×) with no read. 1h keeps it warm; the 2× write
 *    amortizes on the next read.
 *  - 5m — cheaper write (1.25×), for interactive/bursty instances.
 */
const CACHE_CONTROL_1H = { cacheControl: { type: "ephemeral" as const, ttl: "1h" as const } };
const CACHE_CONTROL_5M = { cacheControl: { type: "ephemeral" as const } };

/** Decorate a message with Anthropic's `cacheControl` marker — shared by both breakpoint paths. */
const markAnthropic = (marker: Record<string, unknown>) => (message: ModelMessage): ModelMessage =>
  withProviderCacheMarker(message, "anthropic", marker);

/**
 * Inject Anthropic cross-turn breakpoints (tools+system and history) at the
 * instance's chosen TTL (default 1h). Exported for unit testing; wired via
 * `createProvider`'s `prepareMessages` hook.
 */
export const applyAnthropicPromptCaching: PrepareMessages = (input) =>
  injectCacheBreakpoints(input, markAnthropic(input.ttl === "5m" ? CACHE_CONTROL_5M : CACHE_CONTROL_1H));

/**
 * Within-turn moving breakpoint — marks the last message from step 1 so
 * accumulating tool_use/tool_result blocks cache incrementally. ALWAYS 5m (steps
 * are seconds apart): cheaper write, and — landing after the cross-turn
 * breakpoints — it respects Anthropic's "longer-TTL-first" ordering rule even
 * when the instance runs the cross-turn breakpoints at 1h. Wired via
 * `createProvider`'s `stepMarker` hook.
 */
export const anthropicStepMarker = makeStepMarker(markAnthropic(CACHE_CONTROL_5M));

export const AnthropicProvider = createProvider(
  "anthropic",
  (modelId, apiKeys) => {
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
  },
  { prepareMessages: applyAnthropicPromptCaching, stepMarker: anthropicStepMarker },
);

type AnthropicThinkingOptions =
  | { thinking: { type: "enabled"; budgetTokens: number } }
  | { thinking: { type: "adaptive" }; effort: "low" | "medium" | "high" };

/**
 * Build the `providerOptions.anthropic` object for a thinking-enabled call, at
 * the requested reasoning `level`. Two shapes:
 *   - `adaptive` models (Opus 4.7/4.8, Sonnet 5, Fable 5) → `thinking.type:
 *     "adaptive"` + top-level `effort` (SDK maps to `output_config.effort`).
 *     These REJECT the legacy shape with a 400.
 *   - legacy models (Opus 4.6 and earlier, Haiku/Sonnet 4.x) → `thinking.type:
 *     "enabled"` + a per-level token budget.
 * The gateway supplies `adaptive` from `reasoningControlFor(provider, model) === "adaptive"`.
 */
export function buildAnthropicThinkingOptions(level: string, adaptive: boolean): AnthropicThinkingOptions {
  const lvl: "low" | "medium" | "high" = level === "low" || level === "high" ? level : "medium";
  if (adaptive) return { thinking: { type: "adaptive" }, effort: lvl };
  return { thinking: { type: "enabled", budgetTokens: ANTHROPIC_THINKING_BUDGETS[lvl] } };
}
