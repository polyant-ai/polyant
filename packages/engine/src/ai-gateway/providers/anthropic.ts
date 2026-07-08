// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createProvider, type PrepareMessages } from "./base.js";

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

/**
 * Ephemeral cache breakpoint. Unlike OpenAI (automatic prefix caching, no
 * parameters), Anthropic requires an explicit `cache_control` marker and the
 * `@ai-sdk/anthropic` provider does NOT add one on its own — so without this
 * every Anthropic turn re-pays the full prompt at full price. Default TTL is
 * 5 minutes.
 */
const EPHEMERAL_CACHE_CONTROL = { cacheControl: { type: "ephemeral" as const } };

/** Clone a message adding the ephemeral Anthropic cache breakpoint, preserving any existing providerOptions (deep-merged under `anthropic`). */
function withCacheBreakpoint(message: ModelMessage): ModelMessage {
  const existing = (message as { providerOptions?: Record<string, unknown> }).providerOptions ?? {};
  const existingAnthropic = (existing.anthropic as Record<string, unknown> | undefined) ?? {};
  return {
    ...message,
    providerOptions: {
      ...existing,
      anthropic: { ...existingAnthropic, ...EPHEMERAL_CACHE_CONTROL },
    },
  } as ModelMessage;
}

/**
 * Inject Anthropic prompt-cache breakpoints into a folded request.
 *
 * Two breakpoints (Anthropic allows up to 4):
 *  1. **tools + system** — the AI SDK only honours `cacheControl` on a system
 *     *message*, not on the top-level `system` string, so we move `system` into
 *     a leading `role: "system"` message carrying the breakpoint. Everything
 *     before it in wire order (the tool definitions) is cached with it. This is
 *     the dominant win: the system prompt is byte-identical across every
 *     conversation of an instance, so a write from one conversation is read by
 *     the next within the TTL.
 *  2. **history** — a breakpoint on the last message that precedes the current
 *     turn, so an append-only history becomes incrementally cacheable. It only
 *     fires from the 2nd turn onward (`messages.length >= 2`), which means
 *     single-turn conversations never pay a wasted history cache-write.
 *
 * Exported for unit testing; wired via `createProvider`'s `prepareMessages` hook.
 */
export const applyAnthropicPromptCaching: PrepareMessages = ({ system, messages }) => {
  const out = [...messages];

  // Breakpoint 2 — last history message (the current turn is the last element).
  if (out.length >= 2) {
    const lastHistoryIdx = out.length - 2;
    out[lastHistoryIdx] = withCacheBreakpoint(out[lastHistoryIdx]);
  }

  // Breakpoint 1 — tools + system, as a leading system message.
  if (system && system.length > 0) {
    const systemMessage = withCacheBreakpoint({ role: "system", content: system });
    return { system: undefined, messages: [systemMessage, ...out] };
  }

  return { system, messages: out };
};

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
  { prepareMessages: applyAnthropicPromptCaching },
);

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
