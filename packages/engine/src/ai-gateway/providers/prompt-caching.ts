// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";

/**
 * Shared prompt-cache breakpoint injection for providers that require an
 * EXPLICIT cache marker on the request (Anthropic `cacheControl`, Bedrock
 * `cachePoint`) — unlike OpenAI, which caches a stable prefix automatically.
 *
 * The marker lives under `providerOptions[providerKey]` on a message; the two
 * providers differ ONLY in that key/value pair, so the placement algorithm is
 * factored here and each provider supplies its own marker.
 */

/**
 * Clone `message`, deep-merging `marker` into `providerOptions[providerKey]` and
 * preserving any pre-existing options. Never mutates the input.
 */
export function withProviderCacheMarker(
  message: ModelMessage,
  providerKey: string,
  marker: Record<string, unknown>,
): ModelMessage {
  const existing = (message as { providerOptions?: Record<string, unknown> }).providerOptions ?? {};
  const existingForProvider = (existing[providerKey] as Record<string, unknown> | undefined) ?? {};
  return {
    ...message,
    providerOptions: {
      ...existing,
      [providerKey]: { ...existingForProvider, ...marker },
    },
  } as ModelMessage;
}

/**
 * Inject up to two cache breakpoints into a folded `{ system, messages }`:
 *
 *  1. **tools + system** — the AI SDK only honours a cache marker on a system
 *     *message*, not on the top-level `system` string, so `system` is moved into
 *     a leading `role: "system"` message carrying the marker. Everything before
 *     it in wire order (the tool definitions) is cached with it. This is the
 *     dominant win: the system prompt is byte-identical across every
 *     conversation of an instance.
 *  2. **history** — a marker on the last message preceding the current turn, so
 *     an append-only history becomes incrementally cacheable. It only fires from
 *     the 2nd turn onward (`messages.length >= 2`) so single-turn conversations
 *     never pay a wasted history cache-write.
 *
 * `applyMarker` is the provider-specific decorator (see `withProviderCacheMarker`).
 * Pure function — does not mutate `messages`.
 */
export function injectCacheBreakpoints(
  { system, messages }: { system: string | undefined; messages: ModelMessage[] },
  applyMarker: (message: ModelMessage) => ModelMessage,
): { system: string | undefined; messages: ModelMessage[] } {
  const out = [...messages];

  // Breakpoint 2 — last history message (the current turn is the last element).
  if (out.length >= 2) {
    const lastHistoryIdx = out.length - 2;
    out[lastHistoryIdx] = applyMarker(out[lastHistoryIdx]);
  }

  // Breakpoint 1 — tools + system, as a leading system message.
  if (system && system.length > 0) {
    const systemMessage = applyMarker({ role: "system", content: system });
    return { system: undefined, messages: [systemMessage, ...out] };
  }

  return { system, messages: out };
}

/** Input the AI SDK `prepareStep` hook passes us (subset we use) plus the model id. */
export type StepMarkerInput = { stepNumber: number; messages: ModelMessage[]; modelId: string };

/**
 * Build a `prepareStep` marker — the multi-step companion to
 * `injectCacheBreakpoints`. Within one agentic turn the AI SDK grows the messages
 * array (assistant tool-calls + tool results) on each step; the one-shot
 * breakpoints cover the system prefix and the pre-turn history but NOT the
 * accumulating tool content, so steps 2..N re-send it at full input price. This
 * marks the LAST message on each step so the accumulated prefix is cached
 * step-to-step (a moving breakpoint, on top of the stable system breakpoint).
 *
 * Skips step 0 on purpose: the initial user turn carries the per-turn volatile
 * `<context>` tail, and single-step turns (maxSteps=1 service calls, or a
 * tool-less answer) must not pay a wasted cache-write. From step 1 onward the
 * last message is a stable within-turn tool-result/assistant message — never the
 * volatile user turn — so this is independent of where the volatile block lives.
 *
 * `applyMarker` is the provider-specific decorator; `isCacheCapable` gates
 * providers (Bedrock) where marking a non-cache-capable model errors the call.
 * Pure function — never mutates the input array.
 */
export function makeStepMarker(
  applyMarker: (message: ModelMessage) => ModelMessage,
  isCacheCapable?: (modelId: string) => boolean,
): (input: StepMarkerInput) => { messages?: ModelMessage[] } {
  return ({ stepNumber, messages, modelId }) => {
    if (stepNumber < 1 || messages.length === 0) return {};
    if (isCacheCapable && !isCacheCapable(modelId)) return {};
    const out = [...messages];
    out[out.length - 1] = applyMarker(out[out.length - 1]);
    return { messages: out };
  };
}
