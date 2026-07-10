// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { createProvider, type PrepareMessages } from "./base.js";
import { injectCacheBreakpoints, makeStepMarker, withProviderCacheMarker } from "./prompt-caching.js";

/**
 * Bedrock Converse cache breakpoint. Bedrock uses a `cachePoint` block (via
 * `providerOptions.bedrock.cachePoint`) instead of Anthropic's `cacheControl`;
 * placement is otherwise identical, so it reuses the shared helper. Default TTL
 * is 5 minutes. Bedrock has NO automatic caching, so without this every EU
 * cross-Region turn re-pays the full prompt.
 */
const BEDROCK_CACHE_POINT = { cachePoint: { type: "default" as const } };

/**
 * Only these Bedrock model families support Converse prompt caching. Injecting a
 * `cachePoint` for any other model (Qwen, Nemotron, gpt-oss, MiniMax …) makes
 * Bedrock reject the whole call with a ValidationException, so gate strictly.
 */
const BEDROCK_CACHE_CAPABLE = /anthropic|nova/;

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
  if (!BEDROCK_CACHE_CAPABLE.test(input.modelId)) {
    return { system: input.system, messages: input.messages };
  }
  return injectCacheBreakpoints(input, (message) =>
    withProviderCacheMarker(message, "bedrock", BEDROCK_CACHE_POINT),
  );
};

/**
 * Moving cache breakpoint for the multi-step loop — marks the last message on
 * each step (from step 1), gated to cache-capable model families so a
 * `cachePoint` never reaches a model that rejects it. Wired via
 * `createProvider`'s `stepMarker` hook.
 */
export const bedrockStepMarker = makeStepMarker(
  (message) => withProviderCacheMarker(message, "bedrock", BEDROCK_CACHE_POINT),
  (modelId) => BEDROCK_CACHE_CAPABLE.test(modelId),
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
  { prepareMessages: applyBedrockPromptCaching, stepMarker: bedrockStepMarker },
);
