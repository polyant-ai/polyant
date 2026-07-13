// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { createProvider, type PrepareMessages } from "./base.js";
import { injectCacheBreakpoints, makeStepMarker, withProviderCacheMarker } from "./prompt-caching.js";
import { cacheSupported } from "../config.js";

/**
 * Bedrock Converse cache breakpoint. Bedrock uses a `cachePoint` block (via
 * `providerOptions.bedrock.cachePoint`) instead of Anthropic's `cacheControl`;
 * placement is otherwise identical, so it reuses the shared helper. Default TTL
 * is 5 minutes. Bedrock has NO automatic caching, so without this every EU
 * cross-Region turn re-pays the full prompt.
 */
const BEDROCK_CACHE_POINT = { cachePoint: { type: "default" as const } };

/** Decorate a message with Bedrock's `cachePoint` marker — shared by both breakpoint paths. */
const markBedrock = (message: ModelMessage): ModelMessage =>
  withProviderCacheMarker(message, "bedrock", BEDROCK_CACHE_POINT);

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
    return { system: input.system, messages: input.messages };
  }
  return injectCacheBreakpoints(input, markBedrock);
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
  markBedrock,
  (modelId) => cacheSupported("bedrock", modelId),
);

export const BedrockProvider = createProvider(
  "bedrock",
  (modelId, apiKeys) => {
    const apiKey = apiKeys?.bedrock_api_key?.trim();
    const accessKeyId = apiKeys?.bedrock_access_key_id?.trim();
    const secretAccessKey = apiKeys?.bedrock_secret_access_key?.trim();
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

/** gpt-oss takes an effort level; Claude takes a token budget. */
function isEffortBasedReasoning(modelId: string): boolean {
  return /openai\.gpt-oss/i.test(modelId);
}

/**
 * Bedrock reasoning takes three shapes on `providerOptions.bedrock.reasoningConfig`:
 *   - adaptive Claude (Opus 4.7/4.8, Sonnet 5) → `type:"adaptive"` + maxReasoningEffort.
 *     These REJECT the legacy `type:"enabled"` + budgetTokens with a 400 (live-verified),
 *     exactly like Anthropic 1P — the gateway passes `adaptive` from isReasoningAdaptive.
 *   - OpenAI gpt-oss → `type:"enabled"` + an EFFORT string (maxReasoningEffort).
 *   - legacy Claude (Opus 4.6 and earlier, Haiku/Sonnet 4.x) + MiniMax → `type:"enabled"`
 *     + a token BUDGET (budgetTokens).
 *
 * Only called for a reasoning-capable Bedrock model (gated by isThinkingCapable
 * upstream) and only when thinking is ON.
 *
 * VALIDATED live (eu-south-1): gpt-oss maxReasoningEffort effective; adaptive Claude
 * requires the adaptive shape; budgetTokens ignored for gpt-oss (SDK warns).
 */
export function buildBedrockReasoningOptions(
  modelId: string,
  level: string,
  adaptive: boolean,
): { reasoningConfig: Record<string, unknown> } {
  const normalized: "low" | "medium" | "high" =
    level === "low" || level === "high" ? level : "medium";
  if (adaptive) {
    return { reasoningConfig: { type: "adaptive", maxReasoningEffort: normalized } };
  }
  if (isEffortBasedReasoning(modelId)) {
    return { reasoningConfig: { type: "enabled", maxReasoningEffort: normalized } };
  }
  return {
    reasoningConfig: { type: "enabled", budgetTokens: BEDROCK_THINKING_BUDGETS[normalized] },
  };
}
