// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TierMapping, CostBreakdown } from "./types.js";

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
      "claude-sonnet-5": { input: 3.00, output: 15.00 },
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
      // ponytail: profile ID follows the sonnet-4-6 form; confirm EU invocability + pricing before promoting to `standard`.
      "eu.anthropic.claude-sonnet-5": { input: 3.00, output: 15.00 },
      "eu.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-opus-4-6-v1": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-opus-4-7": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-opus-4-8": { input: 5.00, output: 25.00 },
      "eu.anthropic.claude-fable-5": { input: 5.00, output: 25.00 },
      // Anthropic via Bedrock — Global inference profiles (use-case form may be required)
      "global.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00 },
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00 },
      "global.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00 },
      "global.anthropic.claude-sonnet-5": { input: 3.00, output: 15.00 },
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
      // Reasoning toggle covers Claude + gpt-oss — see isThinkingCapable.
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
 * Per-provider cache pricing multipliers, relative to the base `input` rate.
 *
 *  - `read`  : rate for a cache HIT (cache_read). Anthropic ≈ 0.1×; OpenAI's
 *              automatic caching discounts cached prompt tokens (≈ 0.5× on the
 *              4o/4.1 line, lower on gpt-5 — 0.5 is a documented approximation).
 *  - `write` : rate for a cache WRITE (cache_creation). Anthropic charges a
 *              premium (1.25× for the default 5-minute TTL); OpenAI has no
 *              separate write cost (automatic caching, `cacheWriteTokens` = 0).
 *
 * Providers without a modeled cache (e.g. Nebius) fall back to 1× so cached
 * tokens are never under-priced.
 */
const CACHE_MULTIPLIERS: Record<string, { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 1.25 },
  // Bedrock catalog is Anthropic-dominated; Nova/others report no cache tokens.
  bedrock: { read: 0.1, write: 1.25 },
  openai: { read: 0.5, write: 0 },
};
const DEFAULT_CACHE_MULTIPLIER = { read: 1, write: 1 };

/**
 * Cross-Region inference surcharge for Bedrock (`eu.*` / `global.*` inference
 * profiles). The Bedrock `costPerMillionTokens` table holds the BASE per-token
 * rates (identical to Anthropic/OpenAI first-party); several 2026 pricing
 * analyses report a flat ~10% premium for cross-Region inference profiles on
 * top of that base. AWS's official docs do NOT document a surcharge (historic
 * stance: billed at the source-Region price), so this is modeled as a single
 * explicit knob rather than baked into every table entry: verify against a real
 * Bedrock invoice and set to `1` (or the exact factor) if it differs. Applies
 * to input, output and cache tokens alike.
 */
const BEDROCK_CROSS_REGION_SURCHARGE = 1.1;

/** Matches Bedrock cross-Region inference profile IDs (`us.`/`eu.`/`apac.`/`global.`);
 * in-Region raw model IDs carry no cross-Region surcharge. */
function bedrockRegionalMultiplier(provider: string, model: string): number {
  return provider === "bedrock" && /^(us|eu|apac|global)\./.test(model)
    ? BEDROCK_CROSS_REGION_SURCHARGE
    : 1;
}

/**
 * Estimate the USD cost of a single LLM call.
 *
 * `promptTokens` is the AI SDK's normalized TOTAL input count
 * (`inputTokens` = noCache + cacheRead + cacheWrite). When a `cache` breakdown
 * is supplied, cache reads and writes are re-priced with the provider
 * multipliers above and the remainder is billed at the full input rate. Omitting
 * `cache` reproduces the legacy full-price behaviour exactly.
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
  const mult = CACHE_MULTIPLIERS[provider] ?? DEFAULT_CACHE_MULTIPLIER;
  const regional = bedrockRegionalMultiplier(provider, model);

  const input = (regional * (regularInput * pricing.input)) / 1_000_000;
  const cacheCost =
    (regional * (cacheRead * pricing.input * mult.read)) / 1_000_000 +
    (regional * (cacheWrite * pricing.input * mult.write)) / 1_000_000;
  const output = (regional * (completionTokens * pricing.output)) / 1_000_000;

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
 *   - Bedrock   : Anthropic Claude 4+ (budget-based) + OpenAI gpt-oss (effort-based),
 *                 with or without a region inference-profile prefix (eu./us./apac./global.)
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
      // Bedrock reasoning families (validated live in eu-south-1). Model IDs may
      // carry a cross-region inference profile prefix (eu./us./apac./global.):
      //   - Anthropic Claude 4+ → budget-based reasoning (reasoningConfig.budgetTokens)
      //   - OpenAI gpt-oss      → effort-based reasoning (reasoningConfig.maxReasoningEffort)
      // Both shapes are translated in providers/bedrock.ts (buildBedrockReasoningOptions).
      // Excluded on purpose: Amazon Nova 2 (its reasoningConfig rejects a set
      // maxTokens, which the pipeline may send) and Qwen3/Nemotron/MiniMax (their
      // Converse reasoning parameter is unverified). Add them once handled/validated.
      return /^(?:(?:eu|us|apac|global)\.)?(?:anthropic\.claude-(?:sonnet-4|sonnet-5|opus-4)|openai\.gpt-oss)/.test(modelId);
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
 * Returns true when the model reasons on EVERY call and cannot be switched off —
 * only the effort (low|medium|high) is adjustable, there is no "off".
 *
 * Today this is OpenAI's open-weight gpt-oss (Harmony format, post-trained with
 * CoT-RL), served by Bedrock (`openai.gpt-oss-*`) and Nebius (`…/gpt-oss-*`).
 * Distinct from a HYBRID reasoner (Qwen3.5 with `enable_thinking`) or Claude/
 * OpenAI extended-thinking, all of which have a real off. A model that is
 * always-on is necessarily thinking-capable, so callers use this to REFINE the
 * `isThinkingCapable` verdict — not replace it.
 *
 * Consumed by:
 *   - GET /api/instances/models → the frontend disables the thinking toggle and
 *     shows an "always reasons" hint instead of faking an OFF that does nothing.
 *   - ai-gateway resolveCallConfig (Nebius) → never send the Qwen-only
 *     `enable_thinking:false` kwarg to a model that ignores it.
 *
 * Provider-agnostic on purpose: gpt-oss is gpt-oss whatever serves it.
 */
export function isReasoningAlwaysOn(modelId: string): boolean {
  if (!modelId) return false;
  return /gpt-oss/i.test(modelId);
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
