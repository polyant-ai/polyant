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
      standard: "claude-sonnet-4-6",
      heavy: "claude-opus-4-8",
    },
    costPerMillionTokens: {
      // Haiku 4.5 (fast)
      "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00 },
      // Sonnet family
      "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
      "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00 },
      // Opus family
      "claude-opus-4-8": { input: 5.00, output: 25.00 },
      "claude-opus-4-7": { input: 5.00, output: 25.00 },
      "claude-opus-4-6": { input: 5.00, output: 25.00 },
    },
  },
  bedrock: {
    // Anthropic models on Bedrock require cross-region inference profiles
    // (raw model IDs fail with "Invocation ... with on-demand throughput isn't supported").
    // This catalog is EU-only: every entry is an eu.* / global. profile invocable
    // from EU endpoints (verified against list-inference-profiles in eu-south-1).
    tiers: {
      fast: "eu.amazon.nova-lite-v1:0",
      standard: "eu.anthropic.claude-sonnet-4-6",
      heavy: "eu.anthropic.claude-opus-4-8",
    },
    costPerMillionTokens: {
      // Amazon Nova — EU inference profiles (the `fast` tier targets
      // eu.amazon.nova-lite-v1:0). Raw model IDs are omitted: they are not
      // invocable on-demand from EU regions, only via these eu.* profiles.
      "eu.amazon.nova-micro-v1:0": { input: 0.035, output: 0.14 },
      "eu.amazon.nova-lite-v1:0": { input: 0.06, output: 0.24 },
      "eu.amazon.nova-2-lite-v1:0": { input: 0.06, output: 0.24 },
      "eu.amazon.nova-pro-v1:0": { input: 0.80, output: 3.20 },
      // Anthropic via Bedrock — EU inference profiles.
      // Token rates match Anthropic first-party; the +10% regional-endpoint
      // premium on eu.*/global.* profiles is intentionally not modeled (base rates,
      // consistent across the table). Opus 4.5+ is $5/$25 (not the old $15/$75).
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00 },
      "eu.anthropic.claude-sonnet-4-20250514-v1:0": { input: 3.00, output: 15.00 },
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00 },
      "eu.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00 },
      "eu.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-opus-4-6-v1": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-opus-4-7": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-opus-4-8": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-fable-5": { input: 5.00, output: 25.00 },
      // Anthropic via Bedrock — Global inference profiles (use-case form may be required)
      "global.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00 },
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00 },
      "global.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00 },
      "global.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.00, output: 25.00 },
      "global.anthropic.claude-opus-4-6-v1": { input: 5.00, output: 25.00 },
      "global.anthropic.claude-opus-4-7": { input: 5.00, output: 25.00 },
      "global.anthropic.claude-opus-4-8": { input: 5.00, output: 25.00 },
      "global.anthropic.claude-fable-5": { input: 5.00, output: 25.00 },
      // Non-Anthropic models — direct on-demand IDs (NOT eu.* profiles). In
      // eu-south-1 these are In-Region / ON_DEMAND, so the raw model ID is used.
      // Prices are the Europe (Milan) Standard tier from the AWS pricing page.
      // (DeepSeek and Meta Llama 4 are intentionally omitted: not available in
      // eu-south-1.) Google Gemma 3 and Mistral (Ministral 3 8B/14B, Magistral
      // Small) are also omitted: verified via Bedrock Converse, their chat
      // templates reject a tool-result turn (ValidationException, "The model
      // returned the following errors: ... roles must alternate"), so they
      // cannot drive the agentic tool loop — only single-turn chat. Every model
      // kept below passes a multi-turn tool round-trip.
      // Reasoning toggle stays Claude-only — see isThinkingCapable.
      // Qwen3 — dense + MoE, three sizes
      "qwen.qwen3-32b-v1:0": { input: 0.20, output: 0.79 },
      "qwen.qwen3-coder-30b-a3b-v1:0": { input: 0.20, output: 0.79 },
      "qwen.qwen3-235b-a22b-2507-v1:0": { input: 0.29, output: 1.16 },
      // OpenAI open-weight (gpt-oss)
      "openai.gpt-oss-20b-1:0": { input: 0.09, output: 0.40 },
      "openai.gpt-oss-120b-1:0": { input: 0.20, output: 0.79 },
      // MiniMax
      "minimax.minimax-m2.5": { input: 0.36, output: 1.44 },
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
 *   - Bedrock   : Anthropic-hosted Claude 4 family (sonnet-4, opus-4), with or
 *                 without a region inference-profile prefix (eu./us./apac./global.)
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
      // Bedrock-hosted Claude 4+ variants. Model IDs are cross-region inference
      // profiles, so an optional region prefix (eu./us./apac./global.) precedes
      // the `anthropic.` segment — without it, eu.* profiles were never matched.
      return /^(?:(?:eu|us|apac|global)\.)?anthropic\.claude-(sonnet-4|opus-4)/.test(modelId);
    default:
      return false;
  }
}

/**
 * Clamp a sampling temperature into the valid [0, 2] range. `null`/`undefined`
 * pass through as `null` (meaning "use the provider default"); non-finite
 * inputs are treated as unset.
 */
export function clampTemperature(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(2, Math.max(0, value));
}

/**
 * Whether a (provider, model, thinking) combination accepts a custom
 * temperature. Returns false when thinking is ON (Anthropic requires
 * temperature=1; we generalise to "omit" cross-provider) or when the model is
 * an OpenAI reasoning model (rejects temperature != 1). Mirrors the
 * provider/model pattern logic of isThinkingCapable.
 */
export function temperatureSupported(provider: string, modelId: string, thinking: boolean): boolean {
  if (thinking) return false;
  if (provider === "openai" && /^(o[134]|gpt-5)/.test(modelId)) return false;
  return true;
}
