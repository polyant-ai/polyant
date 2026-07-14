// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TierMapping } from "./types.js";

/** Reasoning-effort levels a model exposes (superset across providers). */
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Single source of truth for per-`(provider, model)` metadata. Every capability
 * gate (reasoning / vision / temperature / cache) and the cost estimator read
 * from this catalog; the brittle per-provider regexes in `config.ts` survive
 * only as a LOGGED fallback for un-catalogued model ids (Bedrock/Nebius drift).
 *
 * Capability values were seeded from the current heuristics (see the
 * `model-catalog.test.ts` cross-check) — the migration is behaviour-preserving.
 * Correcting a value that live-verification shows the heuristic got wrong, and
 * adding new models, is the follow-up (see issue #189 split note).
 *
 * Adding a model = ONE entry here with every field filled in.
 */
export interface ModelCapabilities {
  // — pricing (USD per 1M tokens) —
  /** Regular (uncached) input rate. */
  input: number;
  /** Output rate. */
  output: number;
  /**
   * ABSOLUTE cache-read rate (NOT a multiplier of `input`). Omit when the model
   * has no cache discount — the estimator then bills cached reads at `input`
   * (correct for providers that report cached tokens but give no discount, e.g.
   * Nebius, and for non-cacheable families).
   */
  cacheRead?: number;
  /** ABSOLUTE cache-write rate. Omit → bills writes at `input` (see `cacheRead`). */
  cacheWrite?: number;

  // — capabilities —
  /** Extended thinking / reasoning capable (drives `isThinkingCapable`). */
  reasoning: boolean;
  /**
   * Reasons on EVERY call with no off-switch — only the effort is tunable
   * (gpt-oss). Implies `reasoning: true`. Drives `isReasoningAlwaysOn`.
   */
  reasoningAlwaysOn?: boolean;
  /**
   * How reasoning is CONTROLLED on the wire, for reasoning-capable models. The
   * ai-gateway builds the thinking payload from this — NO model-id regex:
   *   - `"effort"`   → an effort level (OpenAI/Nebius reasoning_effort, Bedrock
   *                    gpt-oss maxReasoningEffort).
   *   - `"budget"`   → a token budget (Anthropic/Bedrock Claude 4.6-and-earlier
   *                    `thinking.type:"enabled"` + budgetTokens; MiniMax on Bedrock).
   *   - `"adaptive"` → Anthropic/Bedrock Claude Opus 4.7/4.8, Sonnet 5, Fable 5:
   *                    `thinking.type:"adaptive"` + effort. LIVE-VERIFIED that these
   *                    REJECT the legacy `enabled`+budgetTokens shape (400).
   * Present ⟺ `reasoning: true`. Drives `reasoningControlFor`.
   */
  reasoningControl?: "effort" | "budget" | "adaptive";
  /**
   * The reasoning-effort levels this model actually accepts, LIVE-VERIFIED against
   * the provider API (the API declares them, e.g. OpenAI's "Supported values are…").
   * Present ⟺ `reasoning: true`. Drives `reasoningLevelsFor` — the API validates and
   * the FE renders the picker from this set, so no model 400s on an out-of-range
   * effort. Budget-control models expose the three preset labels (low/medium/high →
   * token presets). Verified sets differ per model: gpt-5.x add `xhigh`; adaptive
   * Claude add `xhigh`+`max`; o3/gpt-oss/Nebius are low/medium/high only.
   */
  reasoningLevels?: readonly ReasoningLevel[];
  /** Accepts image/file input parts (drives `modelSupportsVision`). */
  vision: boolean;
  /**
   * Accepts the `temperature` sampling param when thinking is OFF. `false` =
   * the param must be omitted entirely (OpenAI reasoning families; Anthropic
   * Opus 4.7/4.8, Sonnet 5, Fable 5). Drives `temperatureSupported`.
   */
  temperature: boolean;
  /**
   * Prompt cache yields a cost discount and (Anthropic/Bedrock) a marker is safe
   * to inject. `false` for families where a cache marker is rejected (Bedrock
   * non-anthropic/nova) or where caching gives no discount (Nebius). Drives
   * `cacheSupported` and the Bedrock runtime marker gate.
   */
  cache: boolean;
}

export interface ProviderConfig {
  tiers: TierMapping;
  /** Per-model capability + pricing catalog. Keyed by exact provider model id. */
  models: {
    [model: string]: ModelCapabilities;
  };
}

export const providerConfigs: Record<string, ProviderConfig> = {
  openai: {
    tiers: {
      fast: "gpt-4o-mini",
      standard: "gpt-4o",
      heavy: "o3",
    },
    models: {
      // Cache-read rates are LIVE-VERIFIED per model against the published pricing
      // page — NOT a blanket multiplier. gpt-4o family = 0.5× input, gpt-4.1 gen =
      // 0.25×, gpt-5.4/5.6 = 0.1×. cacheWrite 0 (no write premium) pre-5.6.
      // GPT-4o family (cached 0.5× input)
      "gpt-4o-mini": { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0, reasoning: false, vision: true, temperature: true, cache: true },
      "gpt-4o": { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: 0, reasoning: false, vision: true, temperature: true, cache: true },
      // GPT-4.1 family (cached 0.25× input)
      "gpt-4.1": { input: 2.00, output: 8.00, cacheRead: 0.50, cacheWrite: 0, reasoning: false, vision: true, temperature: true, cache: true },
      "gpt-4.1-mini": { input: 0.40, output: 1.60, cacheRead: 0.10, cacheWrite: 0, reasoning: false, vision: true, temperature: true, cache: true },
      // GPT-5.4 family — reasoning, reject temperature; cached 0.1× input (official).
      "gpt-5.4": { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      "gpt-5.4-mini": { input: 0.75, output: 4.50, cacheRead: 0.075, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      "gpt-5.4-nano": { input: 0.20, output: 1.25, cacheRead: 0.02, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      // GPT-5.6 family (Sol/Terra/Luna) — cache read 0.1×, cache WRITE 1.25×
      // (absolute published rates; unlike pre-5.6 these DO charge a write premium).
      // reasoningAlwaysOn: LIVE-VERIFIED — with reasoning OFF they still spend
      // reasoning tokens (sol 105 / terra 51 / luna 88), so there is no true off
      // (unlike gpt-5.4, which goes to 0). The UI locks the thinking toggle ON.
      "gpt-5.6-sol": { input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      "gpt-5.6-terra": { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 3.125, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      "gpt-5.6-luna": { input: 1.00, output: 6.00, cacheRead: 0.10, cacheWrite: 1.25, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      // Reasoning — o-series is a pure reasoning model: LIVE-VERIFIED it reasons
      // even with reasoning OFF (576 tokens), so reasoningAlwaysOn.
      "o3": { input: 2.00, output: 8.00, cacheRead: 1.00, cacheWrite: 0, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: false, cache: true },
    },
  },
  anthropic: {
    tiers: {
      fast: "claude-haiku-4-5-20251001",
      standard: "claude-sonnet-4-6",
      heavy: "claude-opus-4-8",
    },
    models: {
      // Anthropic 1P: cache read 0.1× input; cache WRITE 2× input (the 1h cross-turn
      // TTL we default to — a 5m instance over-reports writes slightly, accepted).
      // Opus 4.7/4.8 + Sonnet 5 removed the sampling params → temperature:false.
      // Haiku 4.5 (fast)
      "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 2.00, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      // Sonnet family (sonnet-5 uses the adaptive thinking API)
      "claude-sonnet-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      // Opus family (4.7/4.8 use the adaptive thinking API; 4.6 uses legacy budget)
      "claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-opus-4-6": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
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
    models: {
      // Amazon Nova — EU inference profiles (the `fast` tier targets
      // eu.amazon.nova-lite-v1:0). Raw model IDs are omitted: they are not
      // invocable on-demand from EU regions, only via these eu.* profiles.
      // Nova is not reasoning-capable; nova-micro is text-only (no vision).
      "eu.amazon.nova-micro-v1:0": { input: 0.035, output: 0.14, cacheRead: 0.0035, cacheWrite: 0.04375, reasoning: false, vision: false, temperature: true, cache: true },
      "eu.amazon.nova-lite-v1:0": { input: 0.06, output: 0.24, cacheRead: 0.006, cacheWrite: 0.075, reasoning: false, vision: true, temperature: true, cache: true },
      "eu.amazon.nova-2-lite-v1:0": { input: 0.06, output: 0.24, cacheRead: 0.006, cacheWrite: 0.075, reasoning: false, vision: true, temperature: true, cache: true },
      "eu.amazon.nova-pro-v1:0": { input: 0.80, output: 3.20, cacheRead: 0.08, cacheWrite: 1.00, reasoning: false, vision: true, temperature: true, cache: true },
      // Anthropic via Bedrock — EU inference profiles. Bedrock caches at 5m only →
      // cache read 0.1× input, cache WRITE 1.25× input (absolute rates below).
      // Token rates match Anthropic first-party; cross-Region profiles are billed
      // at the source-Region price (AWS's documented stance — no surcharge modeled).
      // Opus 4.5+ is $5/$25 (not the old $15/$75). Bedrock reasoning covers
      // sonnet-4/sonnet-5/opus-4 (NOT haiku, NOT fable). Sonnet 5 / Opus 4.7-4.8 /
      // Fable 5 reject temperature (mirrors 1P).
      // Haiku 4.5 on Bedrock DOES reason (live-verified: 1306 reasoning chars via
      // budgetTokens) — the old regex wrongly excluded it.
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-sonnet-4-20250514-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      // ponytail: profile ID follows the sonnet-4-6 form; confirm EU invocability + pricing before promoting to `standard`.
      "eu.anthropic.claude-sonnet-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "eu.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-opus-4-6-v1": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "eu.anthropic.claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      // (Bedrock EU has NO claude-fable-5 — "Model not found" live — so no entry.)
      // Anthropic via Bedrock — Global inference profiles (use-case form may be required)
      "global.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-sonnet-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "global.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-opus-4-6-v1": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "global.anthropic.claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      // (Bedrock global claude-fable-5 is unusable — "data retention mode 'default' not available" live — so no entry.)
      // Non-Anthropic models — direct on-demand IDs (NOT eu.* profiles). In
      // eu-south-1 these are In-Region / ON_DEMAND, so the raw model ID is used.
      // Prices are the Europe (Milan) Standard tier from the AWS pricing page.
      // No Converse prompt caching (cache:false) — a cachePoint 400s these families.
      // Qwen3 — dense + MoE. Text-only, non-reasoning on Bedrock.
      "qwen.qwen3-32b-v1:0": { input: 0.20, output: 0.79, reasoning: false, vision: false, temperature: true, cache: false },
      "qwen.qwen3-coder-30b-a3b-v1:0": { input: 0.20, output: 0.79, reasoning: false, vision: false, temperature: true, cache: false },
      "qwen.qwen3-235b-a22b-2507-v1:0": { input: 0.29, output: 1.16, reasoning: false, vision: false, temperature: true, cache: false },
      // Qwen3-Next 80B (MoE A3B) — newer arch than 235b-2507, eval candidate.
      "qwen.qwen3-next-80b-a3b": { input: 0.18, output: 1.41, reasoning: false, vision: false, temperature: true, cache: false },
      // NVIDIA Nemotron — reasoning-capable in general, but its Bedrock Converse
      // reasoning parameter is unverified, so reasoning:false until validated.
      "nvidia.nemotron-super-3-120b": { input: 0.18, output: 0.78, reasoning: false, vision: false, temperature: true, cache: false },
      // OpenAI open-weight (gpt-oss) — effort-based reasoning, always on (no off).
      "openai.gpt-oss-20b-1:0": { input: 0.09, output: 0.40, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "openai.gpt-oss-120b-1:0": { input: 0.20, output: 0.79, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      // MiniMax — DOES reason on Bedrock (live-verified: 2602→4023 reasoning chars
      // low→high via budgetTokens). It also reasons with reasoning OFF, but is left
      // toggleable (not a tier default); see verification notes.
      "minimax.minimax-m2.5": { input: 0.36, output: 1.44, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
    },
  },
  nebius: {
    // Nebius Token Factory — OpenAI-compatible endpoint (see providers/nebius.ts).
    // Model IDs follow the HuggingFace `org/Model` convention and are the exact
    // strings returned by GET /v1/models for the account.
    //
    // Nebius caches automatically but passes NO cost discount (cache:false for all)
    // and accepts the temperature param on every model (temperature:true for all).
    // Reasoning models emit `reasoning_content` [R]; vision-language models [V].
    // Prices are USD per 1M tokens, confirmed from the console prices page.
    tiers: {
      fast: "Qwen/Qwen3-30B-A3B-Instruct-2507",
      standard: "Qwen/Qwen3-235B-A22B-Instruct-2507",
      heavy: "Qwen/Qwen3.5-397B-A17B",
    },
    models: {
      // — General chat (tool-capable, non-reasoning) —
      "meta-llama/Llama-3.3-70B-Instruct": { input: 0.13, output: 0.40, reasoning: false, vision: false, temperature: true, cache: false },
      "Qwen/Qwen3-32B": { input: 0.10, output: 0.30, reasoning: false, vision: false, temperature: true, cache: false },
      "Qwen/Qwen3-30B-A3B-Instruct-2507": { input: 0.10, output: 0.30, reasoning: false, vision: false, temperature: true, cache: false },
      "Qwen/Qwen3-235B-A22B-Instruct-2507": { input: 0.20, output: 0.60, reasoning: false, vision: false, temperature: true, cache: false },
      "google/gemma-3-27b-it": { input: 0.10, output: 0.30, reasoning: false, vision: false, temperature: true, cache: false },
      // — Reasoning [R] (emit reasoning_content) —
      "Qwen/Qwen3.5-397B-A17B": { input: 0.60, output: 3.60, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "Qwen/Qwen3-Next-80B-A3B-Thinking": { input: 0.15, output: 1.20, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "deepseek-ai/DeepSeek-V4-Pro": { input: 1.75, output: 3.50, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "zai-org/GLM-5.1": { input: 1.40, output: 4.40, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "zai-org/GLM-5.2": { input: 1.40, output: 4.40, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "openai/gpt-oss-120b": { input: 0.15, output: 0.60, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "moonshotai/Kimi-K2.7-Code": { input: 0.95, output: 4.00, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "MiniMaxAI/MiniMax-M2.5": { input: 0.30, output: 1.20, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "NousResearch/Hermes-4-70B": { input: 0.13, output: 0.40, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "NousResearch/Hermes-4-405B": { input: 1.00, output: 3.00, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      // NVIDIA Nemotron family [R]
      "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { input: 0.06, output: 0.24, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "nvidia/Nemotron-3-Nano-Omni": { input: 0.06, output: 0.24, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "nvidia/nemotron-3-super-120b-a12b": { input: 0.30, output: 0.90, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1": { input: 0.60, output: 1.80, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "nvidia/Nemotron-3-Ultra-550b-a55b": { input: 1.00, output: 3.00, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      // — Vision-language [V] (also reasoning where noted) —
      "nvidia/Cosmos3-Super-Reasoner": { input: 0.10, output: 0.30, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: false }, // [R][V]
      "moonshotai/Kimi-K2.6": { input: 0.95, output: 4.00, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: false }, // [R][V]
      "Qwen/Qwen2.5-VL-72B-Instruct": { input: 0.25, output: 0.75, reasoning: false, vision: true, temperature: true, cache: false },
      "openbmb/MiniCPM-V-4_5": { input: 0.658, output: 1.11, reasoning: false, vision: true, temperature: true, cache: false },
    },
  },
};

/** Per-`(provider, model)` catalog lookup. `undefined` for un-catalogued ids. */
export function getModelCapabilities(provider: string, modelId: string): ModelCapabilities | undefined {
  return providerConfigs[provider]?.models[modelId];
}

/**
 * Cross-provider lookup by model id alone — for gates that receive no provider
 * (vision). Model ids are effectively unique across providers, so the first
 * match wins. `undefined` for un-catalogued ids.
 */
export function findModelCapabilities(modelId: string): ModelCapabilities | undefined {
  for (const cfg of Object.values(providerConfigs)) {
    const entry = cfg.models[modelId];
    if (entry) return entry;
  }
  return undefined;
}
