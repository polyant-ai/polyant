// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TierMapping, CostBreakdown } from "./types.js";
import { providerConfigs, getModelCapabilities, findModelCapabilities } from "./model-catalog.js";
import type { ModelCapabilities, ReasoningLevel } from "./model-catalog.js";

// The per-model catalog (data) lives in model-catalog.ts; re-exported here so
// existing importers (`./config.js`) keep working. This file holds the LOGIC:
// model resolution, cost estimation, and the capability gates — each now a
// catalog LOOKUP with a logged regex fallback for un-catalogued model ids.
export { providerConfigs } from "./model-catalog.js";
export type { ProviderConfig, ModelCapabilities } from "./model-catalog.js";

export function resolveModel(provider: string, tier: string): string {
  const config = providerConfigs[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);
  const model = config.tiers[tier as keyof TierMapping];
  if (!model) throw new Error(`Unknown tier: ${tier}`);
  return model;
}

/* ------------------------------------------------------------------ */
/*  Regex fallbacks (un-catalogued model ids only)                     */
/* ------------------------------------------------------------------ */

/**
 * The capability gates below prefer the per-model catalog. These regexes are the
 * EXPLICIT fallback for model ids not (yet) in the catalog — Bedrock/Nebius
 * catalogs drift, and a raw id may be requested before its row is added. When a
 * fallback fires, `warnCatalogFallback` logs it once per (gate, provider, model)
 * so divergence is visible. Exported so the catalog-integrity test can assert
 * that every catalogued row matches its heuristic (behaviour-preserving migration).
 */

/** Bedrock families that support Converse prompt caching (`cachePoint`). */
const BEDROCK_CACHE_CAPABLE = /anthropic|nova/;

/** Reasoning-capability fallback — the historical per-provider heuristic. */
export function reasoningCapableFallback(provider: string, modelId: string): boolean {
  if (!provider || !modelId) return false;
  switch (provider) {
    case "openai":
      // Reasoning families: o1, o3, o4 (any suffix) and the gpt-5 line.
      return /^(o[134]|gpt-5)/.test(modelId);
    case "anthropic":
      // Claude 3.7 + the Claude 4 family (sonnet, opus, haiku), sonnet-5, fable-5.
      return /^claude-(3-7|opus-4|sonnet-4|sonnet-5|haiku-4|fable-5)/.test(modelId);
    case "bedrock":
      // Anthropic Claude 4+ (haiku/sonnet/opus — haiku LIVE-VERIFIED to reason on
      // Bedrock) + OpenAI gpt-oss (effort) + MiniMax M (live-verified), with or
      // without a cross-region inference-profile prefix (eu./us./apac./global.).
      return /^(?:(?:eu|us|apac|global)\.)?(?:anthropic\.claude-(?:haiku-4|sonnet-4|sonnet-5|opus-4)|openai\.gpt-oss)|^minimax\.minimax-m/.test(modelId);
    case "nebius":
      // Reasoning families served by Nebius (emit reasoning_content). IDs carry an
      // org prefix, so match the model segment case-insensitively.
      return /(qwen3\.5|-thinking|deepseek-v4|glm-5|gpt-oss|kimi-k2|minimax-m|hermes-4|nemotron|reasoner)/i.test(modelId);
    default:
      return false;
  }
}

/**
 * Always-on-reasoning fallback. LIVE-VERIFIED families that reason on every call
 * even with reasoning OFF (no true off-switch, only effort is tunable):
 *   - gpt-oss (open-weight, Harmony CoT) — whatever provider serves it
 *   - OpenAI o-series (o1/o3/o4) — pure reasoning models
 *   - OpenAI gpt-5.6 (Sol/Terra/Luna) — reason by default; gpt-5.4 does NOT (has a real off)
 *   - MiniMax M (Bedrock `minimax.minimax-m*` AND Nebius `MiniMaxAI/MiniMax-M*`) — both
 *     reason on every call, no working off-switch (live-verified).
 *   - Nebius Kimi K2 + Qwen `-Thinking` — enable_thinking:false is a no-op (live-verified,
 *     still emit reasoning), unlike the toggleable Qwen3.5/GLM which DO turn off.
 */
export function reasoningAlwaysOnFallback(modelId: string): boolean {
  if (!modelId) return false;
  return /gpt-oss|^o[134]\b|gpt-5\.6|minimax-m|kimi-k2|-thinking/i.test(modelId);
}

/**
 * Temperature-REJECTION fallback (true = model rejects the `temperature` param).
 *   - OpenAI always-on reasoning families reject it: o-series (o1/o3/o4) + gpt-5.6
 *     (Sol/Terra/Luna). gpt-5.4 does NOT — LIVE-VERIFIED it accepts temperature with
 *     reasoning OFF (200) and 400s only with reasoning ON, so it is temperature:true
 *     (the reasoning-ON case is handled by temperatureSupported, not by omitting the
 *     param wholesale). Mirrors reasoningAlwaysOnFallback's OpenAI split.
 *   - Anthropic removed sampling params on Opus 4.7/4.8, Sonnet 5, Fable 5.
 *   - Bedrock serves the same Claude models via optional region profiles.
 */
export function temperatureRejectedFallback(provider: string, modelId: string): boolean {
  switch (provider) {
    case "openai":
      return /^o[134]\b|gpt-5\.6/.test(modelId);
    case "anthropic":
      return /^claude-(opus-4-[78]|sonnet-5|fable-5)/.test(modelId);
    case "bedrock":
      return /^(?:(?:eu|us|apac|global)\.)?anthropic\.claude-(opus-4-[78]|sonnet-5|fable-5)/.test(modelId);
    default:
      return false;
  }
}

/**
 * Reasoning-CONTROL fallback — how a reasoning-capable model is driven on the
 * wire, for un-catalogued ids. Consolidates the last two mechanism regexes here
 * (adaptive-Claude + Bedrock gpt-oss effort) so NO provider file branches on a
 * model-id regex. Returns `undefined` for non-reasoning ids.
 *   - adaptive: Anthropic/Bedrock Claude Opus 4.7/4.8, Sonnet 5, Fable 5 (reject
 *     the legacy `enabled`+budgetTokens shape with a 400 — live-verified).
 *   - effort: OpenAI/Nebius reasoning_effort; Bedrock gpt-oss + MiniMax
 *     maxReasoningEffort (MiniMax ignores the level — always reasons — but the effort
 *     shape is the one the SDK forwards without a warning, unlike budgetTokens).
 *   - budget: Anthropic/Bedrock Claude 4.6-and-earlier.
 */
export function reasoningControlFallback(
  provider: string,
  modelId: string,
): "effort" | "budget" | "adaptive" | undefined {
  if (!reasoningCapableFallback(provider, modelId)) return undefined;
  const claudeAdaptive =
    (provider === "anthropic" || provider === "bedrock") &&
    /claude-(?:opus-4-[78]|sonnet-5|fable-5)/.test(modelId);
  if (claudeAdaptive) return "adaptive";
  switch (provider) {
    case "openai":
    case "nebius":
      return "effort";
    case "bedrock":
      return /openai\.gpt-oss|minimax\.minimax-m/i.test(modelId) ? "effort" : "budget";
    case "anthropic":
      return "budget";
    default:
      return undefined;
  }
}

/** Cache-eligibility fallback: Nebius none, Bedrock anthropic/nova only, else yes. */
export function cacheCapableFallback(provider: string, model: string): boolean {
  switch (provider) {
    case "nebius":
      return false;
    case "bedrock":
      return BEDROCK_CACHE_CAPABLE.test(model);
    default:
      return true;
  }
}

/** One-shot warning (deduped per gate+provider+model) when a regex fallback fires. */
const catalogFallbackWarned = new Set<string>();
export function warnCatalogFallback(gate: string, provider: string, modelId: string): void {
  const key = `${gate}:${provider}:${modelId}`;
  if (catalogFallbackWarned.has(key)) return;
  catalogFallbackWarned.add(key);
  console.warn(
    `[ai-gateway] ${gate}: no catalog entry for ${provider || "?"}/${modelId || "?"} — using regex fallback`,
  );
}

/* ------------------------------------------------------------------ */
/*  Cost estimation                                                    */
/* ------------------------------------------------------------------ */

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
function resolveCacheRates(pricing: ModelCapabilities): { read: number; write: number } {
  return {
    read: pricing.cacheRead ?? pricing.input,
    write: pricing.cacheWrite ?? pricing.input,
  };
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
  const pricing = getModelCapabilities(provider, model);
  if (!pricing) return { input: 0, cache: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };

  const cacheRead = Math.max(0, cache?.cachedInputTokens ?? 0);
  const cacheWrite = Math.max(0, cache?.cacheCreationInputTokens ?? 0);
  const regularInput = Math.max(0, promptTokens - cacheRead - cacheWrite);
  const rates = resolveCacheRates(pricing);

  const input = (regularInput * pricing.input) / 1_000_000;
  const cacheReadCost = (cacheRead * rates.read) / 1_000_000;
  const cacheWriteCost = (cacheWrite * rates.write) / 1_000_000;
  const cacheCost = cacheReadCost + cacheWriteCost;
  const output = (completionTokens * pricing.output) / 1_000_000;

  return {
    input,
    cache: cacheCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    output,
    total: input + cacheCost + output,
  };
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

/* ------------------------------------------------------------------ */
/*  Capability gates (catalog lookup, regex fallback)                  */
/* ------------------------------------------------------------------ */

/**
 * Returns true when the (provider, model) pair supports extended thinking /
 * reasoning. Reads the catalog `reasoning` field; falls back to the historical
 * per-provider regex (logged) for un-catalogued ids.
 *
 * Consumed by GET /api/instances/models (frontend toggle hint) and by
 * config-resolver (runtime gate so a stale `thinkingEnabled=true` in DB cannot
 * leak into a non-capable model's request).
 */
export function isThinkingCapable(provider: string, modelId: string): boolean {
  if (!provider || !modelId) return false;
  const entry = getModelCapabilities(provider, modelId);
  if (entry) return entry.reasoning;
  warnCatalogFallback("isThinkingCapable", provider, modelId);
  return reasoningCapableFallback(provider, modelId);
}

/**
 * Returns true when the model reasons on EVERY call and cannot be switched off —
 * only the effort (low|medium|high) is adjustable, there is no "off" (gpt-oss,
 * the OpenAI o-series, and gpt-5.6 — all live-verified). A model that is always-on is necessarily
 * thinking-capable, so callers use this to REFINE the `isThinkingCapable`
 * verdict — not replace it. Takes model id alone (provider-agnostic: gpt-oss is
 * gpt-oss whatever serves it), so it does a cross-provider catalog lookup.
 *
 * Consumed by GET /api/instances/models (frontend locks the toggle ON + shows an
 * "always reasons" hint) and by ai-gateway resolveCallConfig (Nebius: never send
 * the Qwen-only `enable_thinking:false` kwarg to a model that ignores it).
 */
export function isReasoningAlwaysOn(modelId: string): boolean {
  if (!modelId) return false;
  const entry = findModelCapabilities(modelId);
  if (entry) return entry.reasoningAlwaysOn ?? false;
  warnCatalogFallback("isReasoningAlwaysOn", "", modelId);
  return reasoningAlwaysOnFallback(modelId);
}

/**
 * How a (provider, model)'s reasoning is CONTROLLED on the wire — `effort` |
 * `budget` | `adaptive`, or `undefined` for non-reasoning models. The ai-gateway
 * builds the per-model thinking payload from this instead of any model-id regex.
 * Catalog lookup (`reasoningControl`) with a logged fallback. Sending the wrong
 * shape is a hard 400 for adaptive Claude (Opus 4.7/4.8, Sonnet 5, Fable 5).
 */
export function reasoningControlFor(
  provider: string,
  modelId: string,
): "effort" | "budget" | "adaptive" | undefined {
  if (!provider || !modelId) return undefined;
  const entry = getModelCapabilities(provider, modelId);
  if (entry) return entry.reasoningControl;
  warnCatalogFallback("reasoningControlFor", provider, modelId);
  return reasoningControlFallback(provider, modelId);
}

/**
 * Reasoning-LEVELS fallback (which efforts a model accepts) for un-catalogued
 * ids. Derived from the control + the one live-verified per-model exception:
 * OpenAI gpt-5.x add `xhigh`; adaptive Claude add `xhigh`+`max`; everything else
 * (o3, gpt-oss, Nebius, budget presets) is low/medium/high. Empty for non-reasoning.
 */
export function reasoningLevelsFallback(provider: string, modelId: string): readonly ReasoningLevel[] {
  const control = reasoningControlFallback(provider, modelId);
  if (!control) return [];
  if (control === "adaptive") return ["low", "medium", "high", "xhigh", "max"];
  if (control === "effort" && provider === "openai" && /^gpt-5/.test(modelId)) {
    return ["low", "medium", "high", "xhigh"];
  }
  return ["low", "medium", "high"];
}

/**
 * The reasoning-effort levels a (provider, model) accepts. Catalog lookup
 * (`reasoningLevels`, LIVE-VERIFIED) with a logged fallback. Consumed by the
 * frontend (renders the level picker), the API (validation), and the gateway
 * (clamps a requested level). Empty for non-reasoning models.
 */
export function reasoningLevelsFor(provider: string, modelId: string): readonly ReasoningLevel[] {
  if (!provider || !modelId) return [];
  const entry = getModelCapabilities(provider, modelId);
  if (entry) return entry.reasoningLevels ?? [];
  warnCatalogFallback("reasoningLevelsFor", provider, modelId);
  return reasoningLevelsFallback(provider, modelId);
}

/**
 * Clamp a requested reasoning level to what the model actually accepts, falling
 * back to "medium" (which every reasoning model supports). Prevents a direct API
 * caller from sending an out-of-range effort that the provider 400s on — the
 * single enforcement point at the ai-gateway boundary.
 */
export function resolveReasoningLevel(provider: string, modelId: string, requested: string): ReasoningLevel {
  const levels = reasoningLevelsFor(provider, modelId);
  return (levels as readonly string[]).includes(requested) ? (requested as ReasoningLevel) : "medium";
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
 * Whether a (provider, model, thinking) combination accepts a custom temperature.
 * Two gates, both LIVE-VERIFIED against the provider APIs:
 *   1. The catalog `temperature` field — `false` means the param is rejected on
 *      EVERY call (OpenAI o-series + gpt-5.6; Anthropic Opus 4.7/4.8, Sonnet 5,
 *      Fable 5). These are blocked regardless of thinking.
 *   2. Under thinking, a custom temperature is rejected ONLY by the proprietary
 *      strict-reasoning APIs — Anthropic extended thinking (forces temperature=1)
 *      and OpenAI 1P reasoning (gpt-5.4: 200 on temp-only vs 400 on temp+reasoning).
 *      Anthropic-on-Bedrock is those same models (budget/adaptive control). Every
 *      open-weight / vLLM reasoner ACCEPTS temperature alongside reasoning —
 *      gpt-oss, Bedrock MiniMax, and ALL Nebius reasoners (Qwen3.5/GLM/DeepSeek/
 *      Kimi/MiniMax/Hermes/Nemotron/Cosmos — live-verified: every one 200s on
 *      temp+reasoning_effort). (`reasoningAlwaysOn` used to proxy this but wrongly
 *      blocked the toggleable Nebius reasoners.)
 * Un-catalogued ids keep the conservative blanket block under thinking + the
 * logged regex fallback.
 */
export function temperatureSupported(provider: string, modelId: string, thinking: boolean): boolean {
  const entry = getModelCapabilities(provider, modelId);
  if (entry) {
    if (!entry.temperature) return false;
    if (thinking) {
      if (provider === "anthropic" || provider === "openai") return false;
      // Bedrock hosts both: Anthropic Claude (budget/adaptive → reject) and
      // open-weight gpt-oss/MiniMax (effort → accept).
      if (provider === "bedrock" && entry.reasoningControl !== "effort") return false;
    }
    return true;
  }
  if (thinking) return false;
  warnCatalogFallback("temperatureSupported", provider, modelId);
  return !temperatureRejectedFallback(provider, modelId);
}

/**
 * Whether a provider+model's prompt cache yields a COST DISCOUNT (and, for
 * Anthropic/Bedrock, whether we inject a marker). Reads the catalog `cache`
 * field; falls back to the regex heuristic (logged) for un-catalogued ids.
 * Consumed by both the cost display (GET /api/instances/models) and the Bedrock
 * runtime marker gate (providers/bedrock.ts) — ONE source of truth.
 */
export function cacheSupported(provider: string, model: string): boolean {
  const entry = getModelCapabilities(provider, model);
  if (entry) return entry.cache;
  warnCatalogFallback("cacheSupported", provider, model);
  return cacheCapableFallback(provider, model);
}
