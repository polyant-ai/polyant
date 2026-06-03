// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TierMapping } from "./types.js";

export interface ProviderConfig {
  tiers: TierMapping;
  costPerMillionTokens: {
    [model: string]: { input: number; output: number };
  };
}

export const providerConfigs: Record<string, ProviderConfig> = {
  openai: {
    tiers: {
      fast: "gpt-4o-mini",
      standard: "gpt-4o",
      heavy: "o3",
    },
    costPerMillionTokens: {
      // GPT-4o family
      "gpt-4o-mini": { input: 0.15, output: 0.60 },
      "gpt-4o": { input: 2.50, output: 10.00 },
      // GPT-4.1 family
      "gpt-4.1": { input: 2.00, output: 8.00 },
      "gpt-4.1-mini": { input: 0.40, output: 1.60 },
      // GPT-5.4 family
      "gpt-5.4": { input: 2.50, output: 15.00 },
      "gpt-5.4-mini": { input: 0.75, output: 4.50 },
      "gpt-5.4-nano": { input: 0.20, output: 1.25 },
      // Reasoning
      "o3": { input: 2.00, output: 8.00 },
    },
  },
  anthropic: {
    tiers: {
      fast: "claude-haiku-4-5-20251001",
      standard: "claude-sonnet-4-5-20250929",
      heavy: "claude-opus-4-6",
    },
    costPerMillionTokens: {
      "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00 },
      "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00 },
      "claude-opus-4-6": { input: 5.00, output: 25.00 },
    },
  },
  bedrock: {
    // Anthropic models on Bedrock require cross-region inference profiles
    // (raw model IDs fail with "Invocation ... with on-demand throughput isn't supported").
    // Defaults target the `eu.*` profile family for EU-region deployments.
    // Instances in other regions must override `model` with a matching `us.*` / `apac.*` /
    // `global.*` profile ID.
    tiers: {
      fast: "amazon.nova-lite-v1:0",
      standard: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      heavy: "eu.anthropic.claude-opus-4-6-v1",
    },
    costPerMillionTokens: {
      // Amazon Nova (raw IDs — on-demand supported)
      "amazon.nova-micro-v1:0": { input: 0.035, output: 0.14 },
      "amazon.nova-lite-v1:0": { input: 0.06, output: 0.24 },
      "amazon.nova-2-lite-v1:0": { input: 0.06, output: 0.24 },
      "amazon.nova-pro-v1:0": { input: 0.80, output: 3.20 },
      // Anthropic via Bedrock — EU inference profiles
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00 },
      "eu.anthropic.claude-sonnet-4-20250514-v1:0": { input: 3.00, output: 15.00 },
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00 },
      "eu.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00 },
      "eu.anthropic.claude-opus-4-5-20251101-v1:0": { input: 15.00, output: 75.00 },
      "eu.anthropic.claude-opus-4-6-v1": { input: 15.00, output: 75.00 },
      "eu.anthropic.claude-opus-4-7": { input: 15.00, output: 75.00 },
      // Anthropic via Bedrock — Global inference profiles (use-case form may be required)
      "global.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00 },
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00 },
      "global.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00 },
      "global.anthropic.claude-opus-4-5-20251101-v1:0": { input: 15.00, output: 75.00 },
      "global.anthropic.claude-opus-4-6-v1": { input: 15.00, output: 75.00 },
      "global.anthropic.claude-opus-4-7": { input: 15.00, output: 75.00 },
    },
  },
};

export function resolveModel(provider: string, tier: string): string {
  const config = providerConfigs[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);
  const model = config.tiers[tier as keyof TierMapping];
  if (!model) throw new Error(`Unknown tier: ${tier}`);
  return model;
}

export function estimateCost(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const config = providerConfigs[provider];
  if (!config) return 0;
  const pricing = config.costPerMillionTokens[model];
  if (!pricing) return 0;
  return (
    (promptTokens * pricing.input) / 1_000_000 +
    (completionTokens * pricing.output) / 1_000_000
  );
}

export const sttPricingPerMinute: Record<string, Record<string, number>> = {
  openai: {
    "whisper-1": 0.006,
  },
};

export function estimateSttCost(
  provider: string,
  model: string,
  durationSec: number,
): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const providerPricing = sttPricingPerMinute[provider];
  if (!providerPricing) return 0;
  const pricePerMinute = providerPricing[model];
  if (pricePerMinute == null) return 0;
  return (durationSec / 60) * pricePerMinute;
}

/**
 * Returns true when the (provider, model) pair supports extended thinking /
 * reasoning. Pattern-based by provider:
 *
 *   - OpenAI    : reasoning families o1*, o3*, o4*, gpt-5*
 *   - Anthropic : claude-3-7-*, claude-sonnet-4-*, claude-opus-4-*,
 *                 claude-haiku-4-*, and any claude-*-4-[56]-*
 *   - Bedrock   : Anthropic-hosted Claude 4 family (sonnet-4, opus-4)
 *
 * The capability flag is consumed in two places:
 *   - GET /api/instances/models (frontend hint to show/hide the toggle)
 *   - config-resolver (runtime gate so a stale `thinkingEnabled=true` in DB
 *     cannot leak into a non-capable model's request)
 */
export function isThinkingCapable(provider: string, modelId: string): boolean {
  if (!provider || !modelId) return false;
  switch (provider) {
    case "openai":
      // Reasoning families: o1, o3, o4 (any suffix) and the gpt-5 line.
      return /^(o[134]|gpt-5)/.test(modelId);
    case "anthropic":
      // Claude 3.7 + the entire Claude 4 family (sonnet, opus, haiku) and
      // their 4.5/4.6 sub-versions. Examples covered:
      //   claude-3-7-sonnet-*
      //   claude-sonnet-4-5-20250929, claude-opus-4-6, claude-haiku-4-5-*
      return /^claude-(3-7|opus-4|sonnet-4|haiku-4)/.test(modelId);
    case "bedrock":
      // Bedrock-hosted Claude 4+ variants only.
      return /^anthropic\.claude-(sonnet-4|opus-4)/.test(modelId);
    default:
      return false;
  }
}
