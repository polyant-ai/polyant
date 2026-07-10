// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TierMapping, CostBreakdown } from "./types.js";

export interface ProviderConfig {
  tiers: TierMapping;
  costPerMillionTokens: {
    /**
     * All rates are USD per 1M tokens. `cacheRead`/`cacheWrite` are ABSOLUTE
     * published cache prices (NOT multipliers of `input`). Omit them when the
     * model has no cache pricing — the estimator then bills cached tokens at the
     * full `input` rate, which is correct for providers that report cached tokens
     * but give no discount (e.g. Nebius) and for non-cacheable families.
     */
    [model: string]: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
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
      // Pre-GPT-5.6 OpenAI: cache read 0.5× input, NO write premium (cacheWrite 0).
      // GPT-4o family
      "gpt-4o-mini": { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0 },
      "gpt-4o": { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: 0 },
      // GPT-4.1 family
      "gpt-4.1": { input: 2.00, output: 8.00, cacheRead: 1.00, cacheWrite: 0 },
      "gpt-4.1-mini": { input: 0.40, output: 1.60, cacheRead: 0.20, cacheWrite: 0 },
      // GPT-5.4 family
      "gpt-5.4": { input: 2.50, output: 15.00, cacheRead: 1.25, cacheWrite: 0 },
      "gpt-5.4-mini": { input: 0.75, output: 4.50, cacheRead: 0.375, cacheWrite: 0 },
      "gpt-5.4-nano": { input: 0.20, output: 1.25, cacheRead: 0.10, cacheWrite: 0 },
      // GPT-5.6 family (Sol/Terra/Luna) — cache read 0.1×, cache WRITE 1.25×
      // (absolute published rates; unlike pre-5.6 these DO charge a write premium).
      "gpt-5.6-sol": { input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "gpt-5.6-terra": { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 3.125 },
      "gpt-5.6-luna": { input: 1.00, output: 6.00, cacheRead: 0.10, cacheWrite: 1.25 },
      // Reasoning
      "o3": { input: 2.00, output: 8.00, cacheRead: 1.00, cacheWrite: 0 },
    },
  },
  anthropic: {
    tiers: {
      fast: "claude-haiku-4-5-20251001",
      standard: "claude-sonnet-4-6",
      heavy: "claude-opus-4-8",
    },
    costPerMillionTokens: {
      // Anthropic 1P: cache read 0.1× input; cache WRITE 2× input (the 1h cross-turn
      // TTL we default to — a 5m instance over-reports writes slightly, accepted).
      // Haiku 4.5 (fast)
      "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 2.00 },
      // Sonnet family
      "claude-sonnet-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00 },
      "claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00 },
      "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00 },
      // Opus family
      "claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00 },
      "claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00 },
      "claude-opus-4-6": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00 },
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
      "eu.amazon.nova-micro-v1:0": { input: 0.035, output: 0.14, cacheRead: 0.0035, cacheWrite: 0.04375 },
      "eu.amazon.nova-lite-v1:0": { input: 0.06, output: 0.24, cacheRead: 0.006, cacheWrite: 0.075 },
      "eu.amazon.nova-2-lite-v1:0": { input: 0.06, output: 0.24, cacheRead: 0.006, cacheWrite: 0.075 },
      "eu.amazon.nova-pro-v1:0": { input: 0.80, output: 3.20, cacheRead: 0.08, cacheWrite: 1.00 },
      // Anthropic via Bedrock — EU inference profiles. Bedrock caches at 5m only →
      // cache read 0.1× input, cache WRITE 1.25× input (absolute rates below).
      // Token rates match Anthropic first-party; cross-Region profiles are billed
      // at the source-Region price (AWS's documented stance — no surcharge modeled).
      // Opus 4.5+ is $5/$25 (not the old $15/$75).
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
      "eu.anthropic.claude-sonnet-4-20250514-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      "eu.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      // ponytail: profile ID follows the sonnet-4-6 form; confirm EU invocability + pricing before promoting to `standard`.
      "eu.anthropic.claude-sonnet-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      "eu.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "eu.anthropic.claude-opus-4-6-v1": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "eu.anthropic.claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "eu.anthropic.claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "eu.anthropic.claude-fable-5": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      // Anthropic via Bedrock — Global inference profiles (use-case form may be required)
      "global.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      "global.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      "global.anthropic.claude-sonnet-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      "global.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "global.anthropic.claude-opus-4-6-v1": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "global.anthropic.claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "global.anthropic.claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
      "global.anthropic.claude-fable-5": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
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
      // Qwen3 — dense + MoE. Prices are the Europe (Milan) tier.
      "qwen.qwen3-32b-v1:0": { input: 0.20, output: 0.79 },
      "qwen.qwen3-coder-30b-a3b-v1:0": { input: 0.20, output: 0.79 },
      "qwen.qwen3-235b-a22b-2507-v1:0": { input: 0.29, output: 1.16 },
      // Qwen3-Next 80B (MoE A3B) — newer arch than 235b-2507, eval candidate.
      // Tool-loop expected OK (Qwen family) but not yet probe-verified.
      "qwen.qwen3-next-80b-a3b": { input: 0.18, output: 1.41 },
      // NVIDIA Nemotron — reasoning-capable. Eval candidate; tool-loop NOT yet
      // verified (could reject tool-result turns like Gemma/Mistral-small).
      "nvidia.nemotron-super-3-120b": { input: 0.18, output: 0.78 },
      // OpenAI open-weight (gpt-oss)
      "openai.gpt-oss-20b-1:0": { input: 0.09, output: 0.40 },
      "openai.gpt-oss-120b-1:0": { input: 0.20, output: 0.79 },
      // MiniMax
      "minimax.minimax-m2.5": { input: 0.36, output: 1.44 },
    },
  },
  nebius: {
    // Nebius Token Factory — OpenAI-compatible endpoint (see providers/nebius.ts).
    // Model IDs follow the HuggingFace `org/Model` convention and are the exact
    // strings returned by GET /v1/models for the account (authoritative — the
    // catalog below mirrors the 25 served models, minus the embedding-only
    // Qwen/Qwen3-Embedding-8B which belongs to the embedder, not chat).
    //
    // All Nebius models expose native function calling. Reasoning models surface
    // thinking via `reasoning_content` automatically (see isThinkingCapable's
    // `nebius` case) — [R] below. Vision-language models are marked [V] and wired
    // into vision.ts's allowlist (capability from the console modality tag, not
    // the name: e.g. Nemotron-3-Nano-Omni is Text-to-text, Cosmos3 is Vision).
    //
    // Prices are USD per 1M tokens, confirmed from the console prices page
    // (2026-07-06). Cost estimation degrades to 0 for any model left without an
    // entry, so a missing price never breaks a call.
    tiers: {
      fast: "Qwen/Qwen3-30B-A3B-Instruct-2507",
      standard: "Qwen/Qwen3-235B-A22B-Instruct-2507",
      heavy: "Qwen/Qwen3.5-397B-A17B",
    },
    costPerMillionTokens: {
      // — General chat (tool-capable, non-reasoning) —
      "meta-llama/Llama-3.3-70B-Instruct": { input: 0.13, output: 0.40 },
      "Qwen/Qwen3-32B": { input: 0.10, output: 0.30 },
      "Qwen/Qwen3-30B-A3B-Instruct-2507": { input: 0.10, output: 0.30 },
      "Qwen/Qwen3-235B-A22B-Instruct-2507": { input: 0.20, output: 0.60 },
      "google/gemma-3-27b-it": { input: 0.10, output: 0.30 },
      // — Reasoning [R] (emit reasoning_content) —
      "Qwen/Qwen3.5-397B-A17B": { input: 0.60, output: 3.60 },
      "Qwen/Qwen3-Next-80B-A3B-Thinking": { input: 0.15, output: 1.20 },
      "deepseek-ai/DeepSeek-V4-Pro": { input: 1.75, output: 3.50 },
      "zai-org/GLM-5.1": { input: 1.40, output: 4.40 },
      "zai-org/GLM-5.2": { input: 1.40, output: 4.40 },
      "openai/gpt-oss-120b": { input: 0.15, output: 0.60 },
      "moonshotai/Kimi-K2.7-Code": { input: 0.95, output: 4.00 },
      "MiniMaxAI/MiniMax-M2.5": { input: 0.30, output: 1.20 },
      "NousResearch/Hermes-4-70B": { input: 0.13, output: 0.40 },
      "NousResearch/Hermes-4-405B": { input: 1.00, output: 3.00 },
      // NVIDIA Nemotron family [R]
      "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { input: 0.06, output: 0.24 },
      "nvidia/Nemotron-3-Nano-Omni": { input: 0.06, output: 0.24 },
      "nvidia/nemotron-3-super-120b-a12b": { input: 0.30, output: 0.90 },
      "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1": { input: 0.60, output: 1.80 },
      "nvidia/Nemotron-3-Ultra-550b-a55b": { input: 1.00, output: 3.00 },
      // — Vision-language [V] (also reasoning where noted) —
      "nvidia/Cosmos3-Super-Reasoner": { input: 0.10, output: 0.30 }, // [R][V]
      "moonshotai/Kimi-K2.6": { input: 0.95, output: 4.00 }, // [R][V]
      "Qwen/Qwen2.5-VL-72B-Instruct": { input: 0.25, output: 0.75 },
      "openbmb/MiniCPM-V-4_5": { input: 0.658, output: 1.11 },
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

/** Cached-token breakdown for a single call, as normalized by the AI SDK. */
export interface CacheTokenUsage {
  /** Input tokens served from a prompt cache (billed at a reduced rate). */
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache (Anthropic bills these at a premium). */
  cacheCreationInputTokens?: number;
}

/**
 * Resolve the ABSOLUTE per-1M cache read/write rates for a model. Cache rates
 * live directly on the catalog entry (`cacheRead`/`cacheWrite`, published $/1M —
 * not multipliers). When a rate is absent they fall back to the full `input`
 * rate: the correct default for providers that report cached tokens but give no
 * discount (Nebius) and for non-cacheable families. This is the single pricing
 * source — there is no separate multiplier table.
 */
function resolveCacheRates(pricing: {
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
}): { read: number; write: number } {
  return {
    read: pricing.cacheRead ?? pricing.input,
    write: pricing.cacheWrite ?? pricing.input,
  };
}

/**
 * Bedrock model families that support Converse prompt caching (`cachePoint`).
 * A cachePoint on any other family (Qwen, Nemotron, gpt-oss …) makes Bedrock
 * reject the whole call with a ValidationException, so both the runtime marker
 * gate (providers/bedrock.ts) and the cost display consume this ONE source.
 */
export const BEDROCK_CACHE_CAPABLE = /anthropic|nova/;

/**
 * Whether a provider+model supports prompt caching at all. Shared by the marker
 * gate and the model-catalog cost display so they can never drift: Nebius has no
 * cache API; Bedrock caches only the anthropic/nova families; OpenAI (automatic)
 * and Anthropic (explicit marker) always do.
 */
export function cacheSupported(provider: string, model: string): boolean {
  switch (provider) {
    case "nebius":
      return false;
    case "bedrock":
      return BEDROCK_CACHE_CAPABLE.test(model);
    default:
      return true;
  }
}

/**
 * Estimate the USD cost of a single LLM call.
 *
 * `promptTokens` is the AI SDK's normalized TOTAL input count
 * (`inputTokens` = noCache + cacheRead + cacheWrite). When a `cache` breakdown
 * is supplied, cache reads and writes are priced with the model's ABSOLUTE cache
 * rates (`resolveCacheRates`, falling back to the input rate) and the remainder
 * at the full input rate. Omitting `cache` reproduces full-price behaviour.
 */
export function estimateCost(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cache?: CacheTokenUsage,
): number {
  return estimateCostBreakdown(provider, model, promptTokens, completionTokens, cache).total;
}

/**
 * Like `estimateCost`, but returns the per-bucket split (regular input, cache
 * read+write, output) alongside the total. Persisted per-message on
 * `pipeline_traces` so the admin panel can show input/cache/output costs.
 */
export function estimateCostBreakdown(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cache?: CacheTokenUsage,
): CostBreakdown {
  const config = providerConfigs[provider];
  const pricing = config?.costPerMillionTokens[model];
  if (!config || !pricing) return { input: 0, cache: 0, output: 0, total: 0 };

  const cacheRead = Math.max(0, cache?.cachedInputTokens ?? 0);
  const cacheWrite = Math.max(0, cache?.cacheCreationInputTokens ?? 0);
  const regularInput = Math.max(0, promptTokens - cacheRead - cacheWrite);
  const rates = resolveCacheRates(pricing);

  const input = (regularInput * pricing.input) / 1_000_000;
  const cacheCost =
    (cacheRead * rates.read) / 1_000_000 + (cacheWrite * rates.write) / 1_000_000;
  const output = (completionTokens * pricing.output) / 1_000_000;

  return { input, cache: cacheCost, output, total: input + cacheCost + output };
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
      return /^claude-(3-7|opus-4|sonnet-4|sonnet-5|haiku-4)/.test(modelId);
    case "bedrock":
      // Bedrock-hosted Claude 4+ variants. Model IDs are cross-region inference
      // profiles, so an optional region prefix (eu./us./apac./global.) precedes
      // the `anthropic.` segment — without it, eu.* profiles were never matched.
      return /^(?:(?:eu|us|apac|global)\.)?anthropic\.claude-(sonnet-4|sonnet-5|opus-4)/.test(modelId);
    case "nebius":
      // Reasoning families served by Nebius Token Factory (emit reasoning_content).
      // IDs carry an org prefix (Qwen/, deepseek-ai/, zai-org/, nvidia/, …), so
      // match the model segment case-insensitively. Covers Qwen3.5 + *-Thinking,
      // DeepSeek-V4, GLM-5.x, gpt-oss, Kimi-K2.x, MiniMax-M, Hermes-4, every
      // Nemotron, and NVIDIA *Reasoner* variants.
      return /(qwen3\.5|-thinking|deepseek-v4|glm-5|gpt-oss|kimi-k2|minimax-m|hermes-4|nemotron|reasoner)/i.test(modelId);
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
 * Models that reject the `temperature` parameter outright (HTTP 400), even with
 * thinking OFF — the parameter must be omitted entirely, not just left at its
 * default. This is a per-MODEL property, not a per-provider one:
 *   - OpenAI reasoning families (o1/o3/o4, gpt-5) never accepted temperature.
 *   - Anthropic removed sampling params (temperature/top_p/top_k) on Opus 4.7,
 *     Opus 4.8, Sonnet 5 and Fable 5. Opus/Sonnet 4.6 and earlier still accept
 *     temperature, so they are intentionally NOT matched here.
 *   - Bedrock serves the same Claude models via cross-region inference profiles
 *     (optional eu./us./apac./global. prefix before `anthropic.`).
 */
function rejectsTemperature(provider: string, modelId: string): boolean {
  switch (provider) {
    case "openai":
      return /^(o[134]|gpt-5)/.test(modelId);
    case "anthropic":
      return /^claude-(opus-4-[78]|sonnet-5|fable-5)/.test(modelId);
    case "bedrock":
      return /^(?:(?:eu|us|apac|global)\.)?anthropic\.claude-(opus-4-[78]|sonnet-5|fable-5)/.test(modelId);
    default:
      return false;
  }
}

/**
 * Whether a (provider, model, thinking) combination accepts a custom
 * temperature. Returns false when thinking is ON (Anthropic requires
 * temperature=1; we generalise to "omit" cross-provider) or when the model
 * rejects the parameter altogether (see rejectsTemperature). Mirrors the
 * provider/model pattern logic of isThinkingCapable.
 */
export function temperatureSupported(provider: string, modelId: string, thinking: boolean): boolean {
  if (thinking) return false;
  if (rejectsTemperature(provider, modelId)) return false;
  return true;
}
