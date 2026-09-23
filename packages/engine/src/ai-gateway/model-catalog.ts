// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TierMapping } from "./types.js";

/** Reasoning-effort levels a model exposes (superset across providers). */
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * How the gateway expresses thinking ON THE WIRE for a provider's models. The
 * `resolveCallConfig` switch keys on this, NOT on the provider name, so a new
 * provider is a catalog row and zero lines in `ai-gateway/index.ts`:
 *   - `openai` / `anthropic` / `bedrock` → the three 1P `build*Options` helpers.
 *   - `openai-compatible` → the shared `/v1/chat/completions` dialect
 *     (`reasoning_effort` + `chat_template_kwargs`), driven per MODEL by
 *     `reasoningOff`/`reasoningOn` because vLLM chat templates disagree with each
 *     other inside one provider.
 */
export type WireDialect = "openai" | "anthropic" | "bedrock" | "openai-compatible";

/**
 * The wire toggle that switches a model's thinking off, for a model that reasons
 * BY DEFAULT. Sending no thinking config is "off" only for a model whose default
 * is off — which used to be every 1P model and is no longer true of the newest
 * ones, so this field is not the open-weight curiosity it started as:
 *   - `effort-none` → `reasoning_effort: "none"` is honoured (OpenAI gpt-6 sol
 *     and luna, whose default effort is `medium`, and open-weight endpoints that
 *     accept the same value).
 *   - `thinking-disabled` → Anthropic `thinking: { type: "disabled" }` (Claude
 *     Opus 5, which runs adaptive thinking when the parameter is omitted).
 *   - `template-kwarg` → a vLLM chat-template kwarg, forwarded verbatim into the
 *     request body by `@ai-sdk/openai-compatible` (`enable_thinking: false` on
 *     Nebius Qwen3.5 and GLM; the kwarg's NAME differs per model family, which is
 *     why it is data).
 * An ABSENT `reasoningOff` means the effort payload alone decides, which is still
 * true of most models. `reasoningAlwaysOn` models have no off at all and carry
 * neither field.
 */
export type ReasoningToggle =
  | { via: "effort-none" }
  | { via: "thinking-disabled" }
  | { via: "template-kwarg"; kwarg: string; value: unknown };

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
  /**
   * Whether a cache marker may ride on a message that carries TOOL content (a
   * tool call or a tool result). Defaults to true — Anthropic accepts one
   * anywhere. LIVE-VERIFIED false for Amazon Nova on Bedrock: `cachePoint` is
   * accepted in `system` and in a text-only message, but a message holding a
   * `toolUse`/`toolResult` block 400s with "extraneous key [cachePoint] is not
   * permitted", which kills the whole turn the moment the agent uses a tool.
   * Drives `cacheOnToolMessagesSupported` and the Bedrock marker gate.
   */
  cacheOnToolMessages?: boolean;
  /**
   * How thinking is switched OFF for this model, overriding the provider's
   * `defaultReasoningOff`. Set it only where a model disagrees with its own
   * provider — one serving stack can host model families whose chat templates
   * switch off in different ways. Ignored for `reasoningAlwaysOn` models, which
   * have no off.
   */
  reasoningOff?: ReasoningToggle;
  /**
   * How thinking is switched ON, for a model that does NOT reason by default and
   * needs more than an effort level to start (a chat-template kwarg such as
   * `thinking = true`). Absent = the effort payload is enough.
   *
   * Declaring this also OPTS OUT of the provider's `defaultReasoningOff`: a model
   * that must be switched on is already off when nothing is sent, and handing it
   * the provider's off-switch would send a parameter it never declared.
   */
  reasoningOn?: ReasoningToggle;
}

export interface ProviderConfig {
  tiers: TierMapping;
  /**
   * Which wire dialect the gateway speaks to this provider. Drives the thinking
   * payload in `resolveCallConfig` — see {@link WireDialect}.
   */
  wireDialect: WireDialect;
  /**
   * The off-switch this provider's models use unless a row overrides it with its
   * own `reasoningOff`. A provider default rather than a per-row copy because it
   * is a property of the serving stack (a vLLM chat template, an API that honours
   * `reasoning_effort: "none"`), and because it is the only thing that can cover a
   * model id which drifts in before its catalog row exists. Absent = sending no
   * thinking config is off, which is the OpenAI/Anthropic/Bedrock behaviour.
   */
  defaultReasoningOff?: ReasoningToggle;
  /** Per-model capability + pricing catalog. Keyed by exact provider model id. */
  models: {
    [model: string]: ModelCapabilities;
  };
}

/**
 * The provider a request runs on when the agent names none: `provider` is
 * nullable on `instances`, and the gateway resolves an absent one to this.
 * Exported because anyone VALIDATING a model without a provider has to reach
 * the same answer the gateway will — a second literal elsewhere is how a model
 * gets checked against a catalog the agent does not run on.
 */
export const DEFAULT_PROVIDER = "openai";

export const providerConfigs: Record<string, ProviderConfig> = {
  openai: {
    wireDialect: "openai",
    // The gpt-4o and gpt-4.1 families the tiers used to point at are in OpenAI's
    // DEPRECATED list. They are catalogued still — an agent pinned to one keeps
    // its costs priced — but nothing defaults onto them: the tiers are where an
    // agent lands when nobody chose a model, including the service jobs (titles,
    // memory extraction, summaries) of every agent on this provider.
    tiers: {
      fast: "gpt-6-luna",
      standard: "gpt-6-sol",
      heavy: "gpt-6-astra",
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
      // GPT-5.4 family — reasoning with a REAL off-switch (NOT reasoningAlwaysOn).
      // temperature: true — LIVE-VERIFIED on /v1/responses: temperature accepted
      // (HTTP 200) with reasoning OFF, rejected (400) when reasoning is ON. So it
      // is temperature-capable, gated to reasoning-OFF by temperatureSupported
      // (which, under thinking, blocks a custom temperature for EVERY OpenAI +
      // Anthropic model regardless of reasoningAlwaysOn — so gpt-5.4 keeps
      // temperature only with reasoning OFF).
      // Cached 0.1× input (official).
      "gpt-5.4": { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: true, cache: true },
      "gpt-5.4-mini": { input: 0.75, output: 4.50, cacheRead: 0.075, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: true, cache: true },
      "gpt-5.4-nano": { input: 0.20, output: 1.25, cacheRead: 0.02, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: true, cache: true },
      // GPT-5.6 family (Sol/Terra/Luna). Repriced downward since this row was
      // written, and the write premium it used to carry is gone: the published
      // table now has three columns — input, cached input, output — and no cache
      // write at all, which is the pre-5.6 behaviour restored.
      // reasoningAlwaysOn: LIVE-VERIFIED — with reasoning OFF they still spend
      // reasoning tokens (sol 105 / terra 51 / luna 88), so there is no true off
      // (unlike gpt-5.4, which goes to 0). The UI locks the thinking toggle ON.
      "gpt-5.6-sol": { input: 4.00, output: 20.00, cacheRead: 0.40, cacheWrite: 0, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      "gpt-5.6-terra": { input: 2.00, output: 12.00, cacheRead: 0.20, cacheWrite: 0, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      "gpt-5.6-luna": { input: 0.20, output: 1.20, cacheRead: 0.02, cacheWrite: 0, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh"], vision: true, temperature: false, cache: true },
      // GPT-6 family (Astra/Sol/Luna), the generation OpenAI now points at. Prices
      // and capabilities read from the published pricing and model pages
      // (2026-09-23); no cache write column, so cacheWrite 0 like the rest.
      //
      // Two things here are NOT the shape earlier OpenAI rows have, and both bite
      // silently. Their default `reasoning_effort` is `medium`, so a turn with
      // thinking OFF reasons unless we send `none` — hence `reasoningOff`, which
      // until now only open-weight providers needed. And on /v1/chat/completions
      // they call tools ONLY at effort `none`; full tool use needs /v1/responses,
      // which `providers/openai.ts` already routes every thinking-capable model
      // through, so the agent path is on the right endpoint by construction.
      //
      // Astra is the exception inside its own family: its published effort set has
      // no `none`, so it cannot be switched off and is `reasoningAlwaysOn`.
      "gpt-6-astra": { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 0, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "gpt-6-sol": { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], reasoningOff: { via: "effort-none" }, vision: true, temperature: false, cache: true },
      "gpt-6-luna": { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], reasoningOff: { via: "effort-none" }, vision: true, temperature: false, cache: true },
      // Reasoning — o-series is a pure reasoning model: LIVE-VERIFIED it reasons
      // even with reasoning OFF (576 tokens), so reasoningAlwaysOn.
      "o3": { input: 2.00, output: 8.00, cacheRead: 0.50, cacheWrite: 0, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: false, cache: true },
    },
  },
  anthropic: {
    wireDialect: "anthropic",
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
      "claude-sonnet-5": { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 4.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 6.00, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      // Opus family (4.7/4.8 use the adaptive thinking API; 4.6 uses legacy budget)
      "claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-opus-4-6": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      // Fable 5 — Claude-5 generation ($10/$50; cache read 0.1×, 1h write 2×).
      // LIVE-VERIFIED on Anthropic 1P: adaptive thinking (low..max, rejects the
      // legacy budget shape), vision, temperature rejected, not always-on. (Only
      // on the anthropic provider — Bedrock has no invocable fable-5 profile.)
      // Opus 5 and Opus 5.5, and Fable 5.1 beside Fable 5. Prices from the published
      // table (2026-09-23), where cache write is 2× input at the 1h TTL this
      // deployment uses and cache read is 0.1× — except on the two rows below that
      // break that multiplier, which is precisely what an ABSOLUTE `cacheRead`
      // expresses and a multiplier table could not: Fable 5.1 reads at 0.025×
      // ($0.25) and Opus 5.5 at 0.05× ($0.20).
      //
      // Opus 5 needs `reasoningOff`: omitting `thinking` runs ADAPTIVE on it,
      // the opposite of every earlier Claude, so a turn with thinking off keeps
      // reasoning unless the disable is sent. Opus 5.5 and Fable 5.1 cannot be
      // switched off at all (`disabled` is a 400), so they are reasoningAlwaysOn
      // and the panel locks their toggle.
      "claude-opus-5": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 10.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], reasoningOff: { via: "thinking-disabled" }, vision: true, temperature: false, cache: true },
      "claude-opus-5-5": { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 8.00, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-fable-5-1": { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 20.00, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "claude-fable-5": { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 20.00, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
    },
  },
  bedrock: {
    wireDialect: "bedrock",
    // Anthropic models on Bedrock require cross-region inference profiles
    // (raw model IDs fail with "Invocation ... with on-demand throughput isn't supported").
    // This catalog is EU-only: every entry is an eu.* / global. profile invocable
    // from EU endpoints (verified against list-inference-profiles in eu-south-1).
    // Tier defaults deliberately avoid Anthropic: on Bedrock the Claude families
    // sit behind a per-account use-case form, so an account that has not been
    // granted them fails EVERY tier at once — including the service jobs (title,
    // memory, the semantic governance gates) an operator cannot redirect, since
    // `instances.model` overrides only the supervisor turn.
    //
    // `standard` is Nova Pro: the only non-Anthropic family here with BOTH prompt
    // caching and vision (`cacheCapableFallback` limits Bedrock caching to
    // anthropic|nova), which is what a multi-turn supervisor needs. The cost is
    // real and silent — Nova is `reasoning: false`, so an agent with thinking
    // enabled and no explicit `instances.model` loses reasoning on the supervisor
    // turn and on every `spawnTask`, with no error anywhere (ai-gateway/index.ts
    // gates thinking on the capability). No non-Anthropic Bedrock family offers
    // caching, vision AND reasoning together, so this is a choice between them.
    //
    // `heavy` is gpt-oss-120b for its reasoning: its consumers are the semantic
    // governance gates (prompt-injection, PII, topic guardrail in the builds that
    // ship them), which send a short one-shot prompt — so the missing cache costs
    // nothing — and parse a JSON verdict, FAILING OPEN when it does not arrive.
    // CAVEAT, and it is the sharp one: this is a raw on-demand id, not an eu.*/
    // global. inference profile, so its availability is PER-REGION and verified
    // only in eu-south-1. In a region that does not serve it, fast and standard
    // keep working through the Nova profiles while heavy raises a
    // ValidationException its only callers swallow: the gates then block nothing,
    // and the deployment sees one warn line per call. Deploying elsewhere means
    // re-pointing `heavy` at a model that region actually serves.
    tiers: {
      fast: "eu.amazon.nova-lite-v1:0",
      standard: "eu.amazon.nova-pro-v1:0",
      heavy: "openai.gpt-oss-120b-1:0",
    },
    models: {
      // Amazon Nova — EU inference profiles (the `fast` tier targets
      // eu.amazon.nova-lite-v1:0). Raw model IDs are omitted: they are not
      // invocable on-demand from EU regions, only via these eu.* profiles.
      // Nova is not reasoning-capable; nova-micro is text-only (no vision).
      "eu.amazon.nova-micro-v1:0": { input: 0.035, output: 0.14, cacheRead: 0.0035, cacheWrite: 0.04375, reasoning: false, vision: false, temperature: true, cache: true, cacheOnToolMessages: false },
      "eu.amazon.nova-lite-v1:0": { input: 0.06, output: 0.24, cacheRead: 0.006, cacheWrite: 0.075, reasoning: false, vision: true, temperature: true, cache: true, cacheOnToolMessages: false },
      "eu.amazon.nova-2-lite-v1:0": { input: 0.06, output: 0.24, cacheRead: 0.006, cacheWrite: 0.075, reasoning: false, vision: true, temperature: true, cache: true, cacheOnToolMessages: false },
      "eu.amazon.nova-pro-v1:0": { input: 0.80, output: 3.20, cacheRead: 0.08, cacheWrite: 1.00, reasoning: false, vision: true, temperature: true, cache: true, cacheOnToolMessages: false },
      // Anthropic via Bedrock — EU inference profiles. Bedrock caches at 5m only →
      // cache read 0.1× input, cache WRITE 1.25× input (absolute rates below).
      // Token rates track Anthropic first-party, and for Claude 4.5 and later a
      // REGIONAL or multi-region endpoint — which an `eu.` inference profile is —
      // carries a 10% premium over the global one (Anthropic's pricing page,
      // "Regional and multi-region endpoint pricing", read 2026-09-23). This used
      // to say no surcharge was modeled; the eu rows for 4.5+ are +10% now, and
      // Sonnet 4 (pre-4.5) keeps its old price, as the premium does not reach it.
      // Opus 4.5+ is $5/$25 (not the old $15/$75). Bedrock reasoning covers
      // sonnet-4/sonnet-5/opus-4 (NOT haiku, NOT fable). Sonnet 5 / Opus 4.7-4.8 /
      // Fable 5 reject temperature (mirrors 1P).
      // Haiku 4.5 on Bedrock DOES reason (live-verified: 1306 reasoning chars via
      // budgetTokens) — the old regex wrongly excluded it.
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.10, output: 5.50, cacheRead: 0.11, cacheWrite: 1.375, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-sonnet-4-20250514-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.30, output: 16.50, cacheRead: 0.33, cacheWrite: 4.125, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-sonnet-4-6": { input: 3.30, output: 16.50, cacheRead: 0.33, cacheWrite: 4.125, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      // ponytail: profile ID follows the sonnet-4-6 form; confirm EU invocability + pricing before promoting to `standard`.
      "eu.anthropic.claude-sonnet-5": { input: 2.20, output: 11.00, cacheRead: 0.22, cacheWrite: 2.75, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "eu.anthropic.claude-opus-4-5-20251101-v1:0": { input: 5.50, output: 27.50, cacheRead: 0.55, cacheWrite: 6.875, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-opus-4-6-v1": { input: 5.50, output: 27.50, cacheRead: 0.55, cacheWrite: 6.875, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "eu.anthropic.claude-opus-4-7": { input: 5.50, output: 27.50, cacheRead: 0.55, cacheWrite: 6.875, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      "eu.anthropic.claude-opus-4-8": { input: 5.50, output: 27.50, cacheRead: 0.55, cacheWrite: 6.875, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
      // (Bedrock EU has NO claude-fable-5 — "Model not found" live — so no entry.)
      // Anthropic via Bedrock — Global inference profiles (use-case form may be required)
      "global.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, reasoning: true, reasoningControl: "budget", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: true },
      "global.anthropic.claude-sonnet-5": { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50, reasoning: true, reasoningControl: "adaptive", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], vision: true, temperature: false, cache: true },
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
      // MiniMax M2.5 — reasoningAlwaysOn (LIVE-VERIFIED 2026-07-23): returns a
      // reasoningContent block on EVERY call with NO working off-switch (thinking:
      // disabled / enable_thinking:false in additionalModelRequestFields all still
      // reason), matching AWS's model card. NO effective reasoning control either:
      // `budgetTokens` is Anthropic-only (SDK warns + strips it — the prior
      // "budget" classification was wrong), and `maxReasoningEffort` is forwarded
      // cleanly but INERT (low≈high, ~3300-3600 chars). Classified reasoningControl
      // "effort" only so the gateway sends the clean (non-warning) wire shape;
      // MiniMax ignores the level. temperature:true coexists with the always-on
      // reasoning (temp accepted while reasoning — verified).
      "minimax.minimax-m2.5": { input: 0.36, output: 1.44, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
    },
  },
  nebius: {
    wireDialect: "openai-compatible",
    // Qwen3.5-family hybrids reason BY DEFAULT and `reasoning_effort` only tunes
    // intensity, so the vLLM chat-template kwarg is the real off-switch. Declared
    // once here so an un-catalogued model id drifting in still gets it.
    defaultReasoningOff: { via: "template-kwarg", kwarg: "enable_thinking", value: false },
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
      // Qwen3-Next "-Thinking" reasons on EVERY call — enable_thinking:false is a
      // no-op (LIVE-VERIFIED: still emits reasoning) → reasoningAlwaysOn.
      "Qwen/Qwen3-Next-80B-A3B-Thinking": { input: 0.15, output: 1.20, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "deepseek-ai/DeepSeek-V4-Pro": { input: 1.75, output: 3.50, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "zai-org/GLM-5.1": { input: 1.40, output: 4.40, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "zai-org/GLM-5.2": { input: 1.40, output: 4.40, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "openai/gpt-oss-120b": { input: 0.15, output: 0.60, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      // Kimi K2 + MiniMax reason on every call (enable_thinking:false no-op, LIVE-VERIFIED) → reasoningAlwaysOn.
      "moonshotai/Kimi-K2.7-Code": { input: 0.95, output: 4.00, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "MiniMaxAI/MiniMax-M2.5": { input: 0.30, output: 1.20, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
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
      "moonshotai/Kimi-K2.6": { input: 0.95, output: 4.00, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: false }, // [R][V] always-on (LIVE-VERIFIED)
      "Qwen/Qwen2.5-VL-72B-Instruct": { input: 0.25, output: 0.75, reasoning: false, vision: true, temperature: true, cache: false },
      "openbmb/MiniCPM-V-4_5": { input: 0.658, output: 1.11, reasoning: false, vision: true, temperature: true, cache: false },
      // — New on the public endpoints page (2026-09-23), a curated set: the new
      //   generation of each family already here. Prices as published; the
      //   existing rows' prices were checked against the same page and are
      //   unchanged. Capabilities mirror the sibling of the same family on this
      //   provider — same serving stack, same chat template behaviour. The ids
      //   follow the HuggingFace `org/Model` form every Nebius row uses; the page
      //   shows display names, so they are inferred and want one pass against an
      //   authenticated `GET /v1/models` before an agent is pinned to them.
      //   Left out on purpose: `DeepSeek-V4-Flash-0731`, superseded by V4.1 Flash.
      "zai-org/GLM-5.3": { input: 1.40, output: 4.40, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "zai-org/GLM-5.3-Flash": { input: 0.15, output: 0.50, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: false },
      "deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.30, output: 1.20, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: false },
      "deepseek-ai/DeepSeek-V4-Pro-0813": { input: 1.32, output: 3.96, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      // Kimi and MiniMax reason on every call on this provider (LIVE-VERIFIED on
      // their predecessors: enable_thinking:false is a no-op) → reasoningAlwaysOn.
      "moonshotai/Kimi-K3": { input: 3.00, output: 15.00, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: true, temperature: true, cache: false },
      "MiniMaxAI/MiniMax-M3": { input: 0.30, output: 1.20, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      "nvidia/Nemotron-3.5-Lightning": { input: 0.06, output: 0.24, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
    },
  },
};

/** Per-`(provider, model)` catalog lookup. `undefined` for un-catalogued ids. */
export function getModelCapabilities(provider: string, modelId: string): ModelCapabilities | undefined {
  return providerConfigs[provider]?.models[modelId];
}

/** The provider names this file owns, captured before any registration runs. */
const BUILT_IN_PROVIDER_NAMES: ReadonlySet<string> = new Set(Object.keys(providerConfigs));

/**
 * Register a provider's catalog at boot — the extension point for a provider
 * that does not ship in this file (a deployment overlay, a plugin), so it is
 * added without editing the map every request reads. Every gate, the
 * `/api/instances/models` payload and the request validation pick the rows up
 * because they all read the live object rather than a copy.
 *
 * Idempotent by design — re-registering the same provider replaces its config
 * rather than throwing, so a double boot (tests, a warm reload) is harmless.
 * Registering a name the built-in catalog already owns is a programming error and
 * throws: silently shadowing `openai` would move every agent's cost and
 * capability answers with nothing in the log.
 */
export function registerProviderConfig(name: string, config: ProviderConfig): void {
  if (BUILT_IN_PROVIDER_NAMES.has(name)) {
    throw new Error(`Cannot register provider "${name}": the name is owned by the built-in catalog.`);
  }
  providerConfigs[name] = config;
}
