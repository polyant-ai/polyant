// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instructions, ModelMessage, SystemModelMessage } from "ai";

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
 * Clone `message` without the `markerKey` entry under
 * `providerOptions[providerKey]`, dropping containers left empty and keeping
 * every other option. Returns the input itself when it carries no such marker.
 */
export function withoutProviderCacheMarker(message: ModelMessage, providerKey: string, markerKey: string): ModelMessage {
  const existing = (message as { providerOptions?: Record<string, unknown> }).providerOptions;
  const forProvider = existing?.[providerKey] as Record<string, unknown> | undefined;
  if (!existing || !forProvider || !(markerKey in forProvider)) return message;
  const restForProvider = { ...forProvider };
  delete restForProvider[markerKey];
  const providerOptions: Record<string, unknown> = { ...existing };
  if (Object.keys(restForProvider).length > 0) providerOptions[providerKey] = restForProvider;
  else delete providerOptions[providerKey];
  const out = { ...message } as { providerOptions?: Record<string, unknown> };
  if (Object.keys(providerOptions).length > 0) out.providerOptions = providerOptions;
  else delete out.providerOptions;
  return out as ModelMessage;
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
): { instructions: Instructions | undefined; messages: ModelMessage[] } {
  const out = [...messages];

  // Breakpoint 2 — last history message (the current turn is the last element).
  if (out.length >= 2) {
    const lastHistoryIdx = out.length - 2;
    out[lastHistoryIdx] = applyMarker(out[lastHistoryIdx]);
  }

  // Breakpoint 1 — tools + system, as a marked system message.
  //
  // This used to be PREPENDED to `messages`, which AI SDK 7 rejects outright
  // ("System messages are not allowed in the prompt or messages fields").
  // The marker still needs somewhere to live that the provider will read, and
  // v7 provides it: `Instructions` is `string | SystemModelMessage |
  // SystemModelMessage[]`, so the marked message goes to `instructions` and the
  // cacheControl / cachePoint rides along in its providerOptions exactly as
  // before. Not `allowSystemInMessages: true` — that only re-enables the
  // deprecated shape and would leave the same code to migrate later.
  if (system && system.length > 0) {
    return { instructions: applyMarker({ role: "system", content: system }) as SystemModelMessage, messages: out };
  }

  return { instructions: system, messages: out };
}

/**
 * Input the AI SDK `prepareStep` hook passes us (subset we use), plus the model
 * id and the instance's `cacheConfig.userTurn` choice (see `makeStepMarker`).
 */
export type StepMarkerInput = { stepNumber: number; messages: ModelMessage[]; modelId: string; userTurn?: boolean };

export interface StepMarkerOptions {
  /**
   * Provider-specific decorator; it receives the model id because whether a
   * marker may ride on THIS message can depend on the model (Amazon Nova
   * refuses one on tool content).
   */
  applyMarker: (message: ModelMessage, modelId: string) => ModelMessage;
  /** Removes the provider's marker from a message (see `withoutProviderCacheMarker`). */
  clearMarker: (message: ModelMessage) => ModelMessage;
  /** Gates providers (Bedrock) where marking a non-cache-capable model errors the call. */
  isCacheCapable?: (modelId: string) => boolean;
}

/**
 * Build a `prepareStep` marker — the multi-step companion to
 * `injectCacheBreakpoints`. Within one agentic turn the AI SDK grows the messages
 * array (assistant tool-calls + tool results) on each step; the one-shot
 * breakpoints cover the system prefix and the pre-turn history but NOT the
 * accumulating tool content, so steps 2..N re-send it at full input price. This
 * marks the LAST message on each step so the accumulated prefix is cached
 * step-to-step (a moving breakpoint, on top of the stable system breakpoint).
 *
 * The breakpoint MOVES: the SDK feeds the messages this hook returns into the
 * next step, so the previous step's marker is still there. Leaving it would add
 * one breakpoint per step, and Anthropic and Bedrock reject more than four per
 * request (400 "A maximum of 4 blocks with cache_control may be provided") —
 * reached on the third tool step of a turn that also marks instructions and
 * history. Every marker after the current user turn is a
 * within-turn one placed here (the history marker sits before that turn), so
 * they are all cleared before the last message is marked: instructions,
 * history and one moving marker make three at most (four with `userTurn`).
 *
 * Skips step 0 by default: the initial user turn carries the per-turn volatile
 * `<context>` tail, and single-step turns (maxSteps=1 service calls, or a
 * tool-less answer) must not pay a wasted cache-write. From step 1 onward the
 * last message is a stable within-turn tool-result/assistant message — never the
 * volatile user turn — so this is independent of where the volatile block lives.
 *
 * `userTurn: true` (per-instance `cacheConfig.userTurn`, off by default) also
 * marks the last message on step 0 — the current user turn. The cost of skipping
 * it is that step 0 pays the whole user turn at full input price and step 1 then
 * writes it to cache again; with the marker, step 0 writes it and step 1 reads
 * it. That pays off for agents whose turns usually take two or more steps and
 * carry a large user turn (pre-fetched data in the `<context>` tail); an agent
 * that mostly answers in one step pays a cache write it never reads. The marker
 * stays for the rest of the turn: from step 1 the loop below clears only what
 * follows the user turn, so a turn with history carries four breakpoints
 * (instructions, history, user turn, moving), the provider maximum.
 *
 * Pure function — never mutates the input array.
 */
export function makeStepMarker({
  applyMarker,
  clearMarker,
  isCacheCapable,
}: StepMarkerOptions): (input: StepMarkerInput) => { messages?: ModelMessage[] } {
  return ({ stepNumber, messages, modelId, userTurn }) => {
    if (messages.length === 0 || (stepNumber < 1 && !userTurn)) return {};
    if (isCacheCapable && !isCacheCapable(modelId)) return {};
    const out = [...messages];
    if (stepNumber < 1) {
      out[out.length - 1] = applyMarker(out[out.length - 1], modelId);
      return { messages: out };
    }
    const turnStart = out.map((m) => m.role).lastIndexOf("user");
    for (let i = turnStart + 1; i < out.length; i++) out[i] = clearMarker(out[i]);
    out[out.length - 1] = applyMarker(out[out.length - 1], modelId);
    return { messages: out };
  };
}
