// SPDX-License-Identifier: AGPL-3.0-or-later

import { isReasoningAlwaysOn, reasoningOffFor, reasoningOnFor } from "../config.js";
import type { ReasoningToggle } from "../model-catalog.js";

/**
 * The thinking payload for a provider speaking the `openai-compatible` dialect —
 * every `/v1/chat/completions` endpoint serving open-weight models (Nebius, and
 * any provider registered with that dialect). Returned as the
 * `providerOptions.<provider>` object,
 * which `@ai-sdk/openai-compatible` forwards verbatim into the request body.
 *
 * Two things make this more than "send reasoning_effort". First, `reasoning_effort`
 * sets INTENSITY: on most vLLM chat templates it does not switch reasoning off,
 * and a hybrid model (the Qwen3.5 family and friends) reasons BY DEFAULT — so
 * without an explicit off the admin toggle silently does nothing. Second, the
 * off-switch is not one shape: `reasoning_effort: "none"` on some stacks, a
 * chat-template kwarg on others, and the kwarg's own name differs per model
 * family (`enable_thinking`, `thinking_mode`). Both live in the catalog
 * (`defaultReasoningOff` per provider, `reasoningOff` per model), so this
 * function reads data and no provider branches on a model id.
 *
 * `reasoningAlwaysOn` models get NOTHING when thinking is off: they reason on
 * every call and ignore the kwarg, so sending one is noise on the wire and the
 * panel locks their toggle on instead.
 */
export function buildCompatibleReasoningOptions(input: {
  provider: string;
  modelId: string;
  thinking: boolean;
  /** Effort already clamped to the model's catalog `reasoningLevels`. */
  level: string;
}): Record<string, unknown> {
  const { provider, modelId, thinking, level } = input;

  if (thinking) {
    return { reasoningEffort: level, ...toggleToBody(reasoningOnFor(provider, modelId)) };
  }
  if (isReasoningAlwaysOn(provider, modelId)) return {};
  return toggleToBody(reasoningOffFor(provider, modelId));
}

/** Render a catalog toggle as the request-body fragment it stands for. */
function toggleToBody(toggle: ReasoningToggle | undefined): Record<string, unknown> {
  if (!toggle) return {};
  switch (toggle.via) {
    case "effort-none":
      return { reasoningEffort: "none" };
    case "template-kwarg":
      return { chat_template_kwargs: { [toggle.kwarg]: toggle.value } };
    case "thinking-disabled":
      // An Anthropic shape. Reachable only from a catalog row that declared it on
      // an openai-compatible provider, which is a mistake in the row rather than
      // something to translate — `model-catalog.test.ts` refuses the pairing
      // ("declares an off/on switch only in a shape its provider's dialect can
      // send"), and sending nothing is the safe answer if one ever slips through.
      return {};
  }
}
