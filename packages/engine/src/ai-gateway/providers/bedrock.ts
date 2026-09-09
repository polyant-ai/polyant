// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { createProvider, type PrepareMessages } from "./base.js";
import { injectCacheBreakpoints, makeStepMarker, withProviderCacheMarker } from "./prompt-caching.js";
import { cacheSupported, cacheOnToolMessagesSupported } from "../config.js";

/**
 * Bedrock Converse cache breakpoint. Bedrock uses a `cachePoint` block (via
 * `providerOptions.bedrock.cachePoint`) instead of Anthropic's `cacheControl`;
 * placement is otherwise identical, so it reuses the shared helper. Default TTL
 * is 5 minutes. Bedrock has NO automatic caching, so without this every EU
 * cross-Region turn re-pays the full prompt.
 */
const BEDROCK_CACHE_POINT = { cachePoint: { type: "default" as const } };

/**
 * True when the message carries tool content — a tool result (`role: "tool"`) or
 * an assistant tool call. Amazon Nova rejects a `cachePoint` on either
 * (LIVE-VERIFIED: 400 "extraneous key [cachePoint] is not permitted"), and the
 * marker that lands there is the moving within-turn one, so the failure appears
 * only once an agent actually uses a tool — the first turn of every probe passes.
 */
function carriesToolContent(message: ModelMessage): boolean {
  if (message.role === "tool") return true;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const type = (part as { type?: unknown }).type;
    return type === "tool-call" || type === "tool-result";
  });
}

/**
 * Decorate a message with Bedrock's `cachePoint` marker — shared by both
 * breakpoint paths. Returns the message untouched where the model refuses a
 * marker on tool content: the cost is one lost breakpoint, against a 400 that
 * kills the whole turn.
 */
const markBedrockFor =
  (modelId: string) =>
  (message: ModelMessage): ModelMessage => {
    if (carriesToolContent(message) && !cacheOnToolMessagesSupported("bedrock", modelId)) {
      return message;
    }
    return withProviderCacheMarker(message, "bedrock", BEDROCK_CACHE_POINT);
  };

/**
 * Inject Bedrock `cachePoint` breakpoints (tools+system and history) for
 * cache-capable models only. Exported for unit testing; wired via
 * `createProvider`'s `prepareMessages` hook.
 *
 * NOTE: the `cachePoint` wire shape is unit-tested but should be validated
 * against a live Bedrock call before trusting the cost dashboard — same caveat
 * class as the Anthropic caching path.
 */
export const applyBedrockPromptCaching: PrepareMessages = (input) => {
  if (!cacheSupported("bedrock", input.modelId)) {
    return { instructions: input.system, messages: input.messages };
  }
  return injectCacheBreakpoints(input, markBedrockFor(input.modelId));
};

/**
 * Moving cache breakpoint for the multi-step loop — marks the last message on
 * each step (from step 1), gated to cache-capable model families so a
 * `cachePoint` never reaches a model that rejects it. Bedrock's `cachePoint` has
 * no TTL variants, so the step marker reuses the same block as the cross-turn one
 * (unlike Anthropic, where the within-turn marker drops to a 5m TTL). Wired via
 * `createProvider`'s `stepMarker` hook.
 */
export const bedrockStepMarker = makeStepMarker(
  (message, modelId) => markBedrockFor(modelId)(message),
  (modelId) => cacheSupported("bedrock", modelId),
);

export const BedrockProvider = createProvider(
  "bedrock",
  (modelId, apiKeys) => {
    const apiKey = apiKeys?.bedrock_api_key?.trim();
    const accessKeyId = apiKeys?.bedrock_access_key_id?.trim();
    const secretAccessKey = apiKeys?.bedrock_secret_access_key?.trim();
    // CONVENTION-EXCEPTION: process.env.AWS_REGION read directly. It is the
    // deployment's own region, resolved per CALL after the per-instance secret
    // and before the hardcoded fallback — config.ts is loaded once at boot and
    // would freeze a value the instance is allowed to override. This is the read
    // that embeddings-gateway/provider-resolver.ts and
    // server/memories/memory-status.ts name as the original.
    const region = apiKeys?.bedrock_region?.trim() || process.env.AWS_REGION?.trim() || "us-east-1";

    // Per-instance Bedrock API key (bearer token) is the primary auth path and
    // takes precedence over SigV4 — it bypasses AWS credential signing entirely.
    if (apiKey) {
      return createAmazonBedrock({ apiKey, region })(modelId);
    }

    // Explicit per-instance SigV4 credentials. Otherwise delegate to the AWS SDK
    // default provider chain so ECS task roles, EC2 instance metadata, SSO, shared
    // credentials, and the AWS_BEARER_TOKEN_BEDROCK env var all work —
    // @ai-sdk/amazon-bedrock only reads env vars by default.
    if (accessKeyId && secretAccessKey) {
      return createAmazonBedrock({ accessKeyId, secretAccessKey, region })(modelId);
    }

    return createAmazonBedrock({
      region,
      credentialProvider: fromNodeProviderChain(),
    })(modelId);
  },
  { prepareMessages: applyBedrockPromptCaching, stepMarker: bedrockStepMarker, strictTemplate: true },
);

/** Claude reasoning budgets (Bedrock accepts a token budget in [1024, 64000]). */
const BEDROCK_THINKING_BUDGETS: Record<"low" | "medium" | "high", number> = {
  low: 4096,
  medium: 12000,
  high: 24000,
};

/**
 * Bedrock reasoning takes three shapes on `providerOptions.bedrock.reasoningConfig`,
 * selected by the model's catalog `reasoningControl` (NO model-id regex here — the
 * gateway passes `control` from `reasoningControlFor`):
 *   - "adaptive" (Claude Opus 4.7/4.8, Sonnet 5) → `type:"adaptive"` + maxReasoningEffort.
 *     REJECT the legacy `type:"enabled"` + budgetTokens with a 400 (live-verified).
 *   - "effort" (gpt-oss; MiniMax) → `type:"enabled"` + an EFFORT string (maxReasoningEffort).
 *     gpt-oss honours the level; MiniMax ignores it (always reasons) but accepts the
 *     shape without the warning `budgetTokens` triggers on non-Anthropic models.
 *   - "budget" (Claude 4.6-and-earlier, Haiku/Sonnet 4.x) → `type:"enabled"`
 *     + a token BUDGET (budgetTokens). NOT MiniMax — it is "effort" (see above);
 *     budgetTokens is Anthropic-only and warns on non-Anthropic Bedrock models.
 *
 * Only called for a reasoning-capable Bedrock model (gated by isThinkingCapable
 * upstream) and only when thinking is ON.
 */
export function buildBedrockReasoningOptions(
  level: string,
  control: "effort" | "budget" | "adaptive",
): { reasoningConfig: Record<string, unknown> } {
  // adaptive/effort forward the level as-is — the gateway (resolveReasoningLevel)
  // already clamped it to this model's catalog `reasoningLevels` (adaptive Claude
  // accept up to `max`; gpt-oss only low/medium/high). budget maps to a token
  // preset (budget models expose only the three preset levels).
  if (control === "adaptive") {
    return { reasoningConfig: { type: "adaptive", maxReasoningEffort: level } };
  }
  if (control === "effort") {
    return { reasoningConfig: { type: "enabled", maxReasoningEffort: level } };
  }
  const budgetKey: "low" | "medium" | "high" = level === "low" || level === "high" ? level : "medium";
  return {
    reasoningConfig: { type: "enabled", budgetTokens: BEDROCK_THINKING_BUDGETS[budgetKey] },
  };
}
