// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { resolveModel, estimateCost, estimateCostBreakdown, estimateSttCost, providerConfigs, isThinkingCapable, isReasoningAlwaysOn, clampTemperature, temperatureSupported, cacheSupported } from "./config.js";

describe("resolveModel", () => {
  it("resolves openai fast tier", () => {
    expect(resolveModel("openai", "fast")).toBe("gpt-4o-mini");
  });

  it("resolves openai standard tier", () => {
    expect(resolveModel("openai", "standard")).toBe("gpt-4o");
  });

  it("resolves openai heavy tier", () => {
    expect(resolveModel("openai", "heavy")).toBe("o3");
  });

  it("resolves anthropic fast tier", () => {
    expect(resolveModel("anthropic", "fast")).toBe("claude-haiku-4-5-20251001");
  });

  it("resolves anthropic standard tier", () => {
    expect(resolveModel("anthropic", "standard")).toBe("claude-sonnet-4-6");
  });

  it("resolves anthropic heavy tier", () => {
    expect(resolveModel("anthropic", "heavy")).toBe("claude-opus-4-8");
  });

  it("throws for unknown provider", () => {
    expect(() => resolveModel("gemini", "fast")).toThrow("Unknown provider: gemini");
  });

  it("throws for unknown tier", () => {
    expect(() => resolveModel("openai", "turbo")).toThrow("Unknown tier: turbo");
  });
});

describe("estimateCost", () => {
  it("calculates cost for gpt-4o-mini correctly", () => {
    const cost = estimateCost("openai", "gpt-4o-mini", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.15 + 0.60, 5);
  });

  it("calculates cost for gpt-4o correctly", () => {
    const cost = estimateCost("openai", "gpt-4o", 500, 200);
    expect(cost).toBeCloseTo((500 * 2.50) / 1_000_000 + (200 * 10.0) / 1_000_000, 10);
  });

  it("calculates cost for anthropic claude-sonnet correctly", () => {
    const cost = estimateCost("anthropic", "claude-sonnet-4-5-20250929", 1000, 500);
    expect(cost).toBeCloseTo((1000 * 3.0) / 1_000_000 + (500 * 15.0) / 1_000_000, 10);
  });

  it("returns 0 for unknown provider", () => {
    expect(estimateCost("gemini", "gemini-pro", 1000, 1000)).toBe(0);
  });

  it("breakdown splits input/cache/output and sums to the total", () => {
    const b = estimateCostBreakdown("anthropic", "claude-sonnet-4-6", 1000, 500, {
      cachedInputTokens: 200,
      cacheCreationInputTokens: 100,
    });
    // regular input = 1000 - 200 - 100 = 700; cache = read + write; output = 500.
    expect(b.cache).toBeGreaterThan(0);
    expect(b.output).toBeGreaterThan(0);
    expect(b.input + b.cache + b.output).toBeCloseTo(b.total, 12);
    // cache splits into read + write, and a write costs more than a read (Anthropic 1.25× vs 0.1×).
    expect(b.cacheRead + b.cacheWrite).toBeCloseTo(b.cache, 12);
    expect(b.cacheRead).toBeGreaterThan(0);
    expect(b.cacheWrite).toBeGreaterThan(0);
    expect(b.cacheWrite).toBeGreaterThan(b.cacheRead);
    // total must match the scalar estimateCost for the same inputs.
    expect(b.total).toBeCloseTo(
      estimateCost("anthropic", "claude-sonnet-4-6", 1000, 500, {
        cachedInputTokens: 200,
        cacheCreationInputTokens: 100,
      }),
      12,
    );
  });

  it("breakdown is all-zero for an unpriced model", () => {
    expect(estimateCostBreakdown("openai", "gpt-5-turbo", 1000, 1000)).toEqual({
      input: 0,
      cache: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      total: 0,
    });
  });

  it("returns 0 for unknown model", () => {
    expect(estimateCost("openai", "gpt-5-turbo", 1000, 1000)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCost("openai", "gpt-4o", 0, 0)).toBe(0);
  });

  it("is unchanged when no cache breakdown is passed (backward compatible)", () => {
    const withoutArg = estimateCost("anthropic", "claude-sonnet-4-6", 1000, 500);
    const withEmpty = estimateCost("anthropic", "claude-sonnet-4-6", 1000, 500, {});
    expect(withEmpty).toBeCloseTo(withoutArg, 12);
    expect(withEmpty).toBeCloseTo((1000 * 3.0) / 1_000_000 + (500 * 15.0) / 1_000_000, 12);
  });

  it("prices Anthropic cache reads at 0.1x the input rate", () => {
    // 1000 total input, 800 of them a cache hit → 200 full + 800 * 0.1
    const cost = estimateCost("anthropic", "claude-sonnet-4-6", 1000, 500, {
      cachedInputTokens: 800,
    });
    const expected =
      (200 * 3.0) / 1_000_000 + (800 * 3.0 * 0.1) / 1_000_000 + (500 * 15.0) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
    // Cheaper than pricing everything at full input rate.
    expect(cost).toBeLessThan(estimateCost("anthropic", "claude-sonnet-4-6", 1000, 500));
  });

  it("prices Anthropic cache writes at 2x the input rate (1h cross-turn TTL)", () => {
    // 1000 total input, 600 written to cache → 400 full + 600 * 2.0
    const cost = estimateCost("anthropic", "claude-sonnet-4-6", 1000, 500, {
      cacheCreationInputTokens: 600,
    });
    const expected =
      (400 * 3.0) / 1_000_000 + (600 * 3.0 * 2.0) / 1_000_000 + (500 * 15.0) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
    // Cache writes cost MORE than the plain input rate (break-even trade-off).
    expect(cost).toBeGreaterThan(estimateCost("anthropic", "claude-sonnet-4-6", 1000, 500));
  });

  it("prices OpenAI cache reads at 0.5x and has no write cost", () => {
    const cost = estimateCost("openai", "gpt-4o", 1000, 200, {
      cachedInputTokens: 400,
    });
    const expected =
      (600 * 2.5) / 1_000_000 + (400 * 2.5 * 0.5) / 1_000_000 + (200 * 10.0) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("prices GPT-5.6 cache read at 0.1x and cache WRITE at 1.25x (per-model override)", () => {
    // gpt-5.6-luna: input $1/1M, output $6/1M. 1000 input = 200 full + 600 read + 200 write.
    const cost = estimateCost("openai", "gpt-5.6-luna", 1000, 500, {
      cachedInputTokens: 600,
      cacheCreationInputTokens: 200,
    });
    const expected =
      (200 * 1.0) / 1_000_000 + // regular input
      (600 * 1.0 * 0.1) / 1_000_000 + // cache read 0.1x
      (200 * 1.0 * 1.25) / 1_000_000 + // cache write 1.25x
      (500 * 6.0) / 1_000_000; // output
    expect(cost).toBeCloseTo(expected, 12);
    // The per-model override must NOT leak to the pre-5.6 provider default.
    expect(estimateCost("openai", "gpt-4o", 1000, 0, { cacheCreationInputTokens: 1000 })).toBeCloseTo(
      0, // gpt-4o write multiplier is 0 → cache writes are free
      12,
    );
  });

  it("clamps a cache breakdown larger than the prompt total to non-negative regular input", () => {
    const cost = estimateCost("anthropic", "claude-sonnet-4-6", 500, 0, {
      cachedInputTokens: 900,
    });
    // regularInput clamps to 0; only the cache read is billed.
    expect(cost).toBeCloseTo((900 * 3.0 * 0.1) / 1_000_000, 12);
  });

  it("prices Bedrock cross-Region (eu.*) profiles at the base rate — no surcharge", () => {
    const base = (1000 * 3.0) / 1_000_000 + (500 * 15.0) / 1_000_000;
    expect(estimateCost("bedrock", "eu.anthropic.claude-sonnet-4-6", 1000, 500)).toBeCloseTo(base, 12);
  });
});

describe("cacheSupported", () => {
  it("is false for Nebius (caches automatically but passes no cost discount)", () => {
    expect(cacheSupported("nebius", "Qwen/Qwen3-235B-A22B-Instruct-2507")).toBe(false);
  });

  it("is true for OpenAI and Anthropic", () => {
    expect(cacheSupported("openai", "gpt-4o")).toBe(true);
    expect(cacheSupported("anthropic", "claude-sonnet-4-6")).toBe(true);
  });

  it("is family-gated for Bedrock (anthropic/nova only)", () => {
    expect(cacheSupported("bedrock", "eu.anthropic.claude-sonnet-4-6")).toBe(true);
    expect(cacheSupported("bedrock", "eu.amazon.nova-lite-v1:0")).toBe(true);
    expect(cacheSupported("bedrock", "qwen.qwen3-32b-v1:0")).toBe(false);
  });
});

describe("estimateSttCost", () => {
  it("computes whisper-1 at $0.006 per minute", () => {
    expect(estimateSttCost("openai", "whisper-1", 60)).toBeCloseTo(0.006, 10);
  });

  it("scales linearly with duration", () => {
    expect(estimateSttCost("openai", "whisper-1", 30)).toBeCloseTo(0.003, 10);
    expect(estimateSttCost("openai", "whisper-1", 120)).toBeCloseTo(0.012, 10);
  });

  it("returns 0 for unknown provider", () => {
    expect(estimateSttCost("aws", "transcribe-streaming", 60)).toBe(0);
  });

  it("returns 0 for unknown model", () => {
    expect(estimateSttCost("openai", "whisper-2", 60)).toBe(0);
  });

  it("returns 0 for non-positive duration", () => {
    expect(estimateSttCost("openai", "whisper-1", 0)).toBe(0);
    expect(estimateSttCost("openai", "whisper-1", -5)).toBe(0);
    expect(estimateSttCost("openai", "whisper-1", Number.NaN)).toBe(0);
  });
});

describe("providerConfigs", () => {
  it("has openai and anthropic providers", () => {
    expect(Object.keys(providerConfigs)).toContain("openai");
    expect(Object.keys(providerConfigs)).toContain("anthropic");
  });

  it("has the nebius provider", () => {
    expect(Object.keys(providerConfigs)).toContain("nebius");
  });

  it("each provider has all three tiers", () => {
    for (const provider of Object.values(providerConfigs)) {
      expect(provider.tiers).toHaveProperty("fast");
      expect(provider.tiers).toHaveProperty("standard");
      expect(provider.tiers).toHaveProperty("heavy");
    }
  });

  it("each tier model has cost data", () => {
    for (const provider of Object.values(providerConfigs)) {
      for (const model of Object.values(provider.tiers)) {
        expect(provider.models).toHaveProperty(model);
        const pricing = provider.models[model];
        expect(pricing.input).toBeGreaterThan(0);
        expect(pricing.output).toBeGreaterThan(0);
      }
    }
  });
});

describe("isThinkingCapable", () => {
  describe("OpenAI", () => {
    it.each([
      ["o1", true],
      ["o1-mini", true],
      ["o3", true],
      ["o3-mini", true],
      ["o4", true],
      ["o4-mini", true],
      ["gpt-5", true],
      ["gpt-5.4", true],
      ["gpt-5.4-mini", true],
      ["gpt-5.4-nano", true],
      ["gpt-4o", false],
      ["gpt-4o-mini", false],
      ["gpt-4.1", false],
      ["gpt-4.1-mini", false],
    ])("openai/%s -> %s", (model, expected) => {
      expect(isThinkingCapable("openai", model)).toBe(expected);
    });
  });

  describe("Anthropic", () => {
    it.each([
      ["claude-3-7-sonnet-20250219", true],
      ["claude-sonnet-5", true],
      ["claude-sonnet-4-6", true],
      ["claude-sonnet-4-5-20250929", true],
      ["claude-opus-4-8", true],
      ["claude-opus-4-6", true],
      ["claude-haiku-4-5-20251001", true],
      ["claude-3-5-sonnet-20241022", false],
      ["claude-3-5-haiku-20241022", false],
      ["claude-3-opus-20240229", false],
    ])("anthropic/%s -> %s", (model, expected) => {
      expect(isThinkingCapable("anthropic", model)).toBe(expected);
    });
  });

  describe("Bedrock", () => {
    it.each([
      ["anthropic.claude-sonnet-4-20250514-v1:0", true],
      ["eu.anthropic.claude-sonnet-5", true],
      ["global.anthropic.claude-sonnet-5", true],
      ["anthropic.claude-opus-4-20250514-v1:0", true],
      // OpenAI open-weight (gpt-oss) — effort-based reasoning, raw IDs (no region prefix).
      ["openai.gpt-oss-120b-1:0", true],
      ["openai.gpt-oss-20b-1:0", true],
      ["anthropic.claude-3-5-haiku-20241022-v1:0", false],
      // Nova 2 excluded on purpose (its reasoningConfig rejects a set maxTokens,
      // verified live); Nova v1 is not a reasoning model at all.
      ["eu.amazon.nova-2-lite-v1:0", false],
      ["amazon.nova-lite-v1:0", false],
      ["eu.amazon.nova-lite-v1:0", false],
      ["amazon.nova-pro-v1:0", false],
      ["meta.llama4-scout-17b-instruct-v1:0", false],
      ["meta.llama3-1-70b-instruct-v1:0", false],
      ["qwen.qwen3-32b-v1:0", false],
      ["nvidia.nemotron-super-3-120b", false],
      ["minimax.minimax-m2.5", false],
      ["mistral.mistral-large-2402-v1:0", false],
    ])("bedrock/%s -> %s", (model, expected) => {
      expect(isThinkingCapable("bedrock", model)).toBe(expected);
    });
  });

  describe("Nebius", () => {
    it.each([
      ["Qwen/Qwen3.5-397B-A17B", true],
      ["Qwen/Qwen3-Next-80B-A3B-Thinking", true],
      ["deepseek-ai/DeepSeek-V4-Pro", true],
      ["zai-org/GLM-5.1", true],
      ["zai-org/GLM-5.2", true],
      ["openai/gpt-oss-120b", true],
      ["moonshotai/Kimi-K2.6", true],
      ["MiniMaxAI/MiniMax-M2.5", true],
      ["NousResearch/Hermes-4-405B", true],
      ["nvidia/nemotron-3-super-120b-a12b", true],
      ["nvidia/Cosmos3-Super-Reasoner", true],
      ["meta-llama/Llama-3.3-70B-Instruct", false],
      ["Qwen/Qwen3-32B", false],
      ["Qwen/Qwen3-235B-A22B-Instruct-2507", false],
      ["Qwen/Qwen2.5-VL-72B-Instruct", false],
      ["google/gemma-3-27b-it", false],
    ])("nebius/%s -> %s", (model, expected) => {
      expect(isThinkingCapable("nebius", model)).toBe(expected);
    });
  });

  describe("edge cases", () => {
    it("returns false for unknown provider", () => {
      expect(isThinkingCapable("unknown", "claude-sonnet-4-5-20250929")).toBe(false);
    });

    it("returns false for empty model", () => {
      expect(isThinkingCapable("anthropic", "")).toBe(false);
    });

    it("returns false for empty provider", () => {
      expect(isThinkingCapable("", "o3")).toBe(false);
    });

    it("does not match Claude 3.5 Sonnet (must be 3.7+)", () => {
      expect(isThinkingCapable("anthropic", "claude-3-5-sonnet-20241022")).toBe(false);
      expect(isThinkingCapable("anthropic", "claude-3-7-sonnet-20250219")).toBe(true);
    });
  });
});

describe("isReasoningAlwaysOn", () => {
  it.each([
    // gpt-oss reasons on EVERY call (no off), whatever provider serves it.
    ["openai.gpt-oss-120b-1:0", true],
    ["openai.gpt-oss-20b-1:0", true],
    ["us.openai.gpt-oss-120b-1:0", true],
    ["openai/gpt-oss-120b", true],
    // Hybrid (Qwen) / budget-based (Claude) / OpenAI reasoning all have a real off.
    ["Qwen/Qwen3.5-397B-A17B", false],
    ["eu.anthropic.claude-sonnet-5", false],
    ["o3", false],
    ["gpt-4o", false],
    ["", false],
  ])("%s -> %s", (model, expected) => {
    expect(isReasoningAlwaysOn(model)).toBe(expected);
  });
});

describe("clampTemperature", () => {
  it("passes through null/undefined", () => {
    expect(clampTemperature(null)).toBeNull();
    expect(clampTemperature(undefined)).toBeNull();
  });
  it("returns null for non-finite", () => {
    expect(clampTemperature(NaN)).toBeNull();
    expect(clampTemperature(Infinity)).toBeNull();
    expect(clampTemperature(-Infinity)).toBeNull();
  });
  it("keeps in-range values", () => {
    expect(clampTemperature(0)).toBe(0);
    expect(clampTemperature(0.7)).toBe(0.7);
    expect(clampTemperature(2)).toBe(2);
  });
  it("clamps out-of-range values", () => {
    expect(clampTemperature(-1)).toBe(0);
    expect(clampTemperature(5)).toBe(2);
  });
});

describe("temperatureSupported", () => {
  it("returns false when thinking is on, any provider", () => {
    expect(temperatureSupported("openai", "gpt-4o", true)).toBe(false);
    expect(temperatureSupported("anthropic", "claude-sonnet-4-6", true)).toBe(false);
    expect(temperatureSupported("bedrock", "eu.amazon.nova-lite-v1:0", true)).toBe(false);
  });
  it("returns false for OpenAI reasoning models", () => {
    expect(temperatureSupported("openai", "o3", false)).toBe(false);
    expect(temperatureSupported("openai", "gpt-5.4", false)).toBe(false);
    expect(temperatureSupported("openai", "o1", false)).toBe(false);
    expect(temperatureSupported("openai", "o4", false)).toBe(false);
  });
  it("returns true for standard chat models", () => {
    expect(temperatureSupported("openai", "gpt-4o", false)).toBe(true);
    expect(temperatureSupported("anthropic", "claude-sonnet-4-6", false)).toBe(true);
    expect(temperatureSupported("bedrock", "qwen.qwen3-32b-v1:0", false)).toBe(true);
  });
  it("returns false for Anthropic models that removed sampling params (Opus 4.7/4.8, Sonnet 5, Fable 5)", () => {
    expect(temperatureSupported("anthropic", "claude-opus-4-7", false)).toBe(false);
    expect(temperatureSupported("anthropic", "claude-opus-4-8", false)).toBe(false);
    expect(temperatureSupported("anthropic", "claude-sonnet-5", false)).toBe(false);
    expect(temperatureSupported("anthropic", "claude-fable-5", false)).toBe(false);
  });
  it("returns false for Bedrock cross-region profiles of those models", () => {
    expect(temperatureSupported("bedrock", "eu.anthropic.claude-opus-4-8", false)).toBe(false);
    expect(temperatureSupported("bedrock", "us.anthropic.claude-sonnet-5", false)).toBe(false);
    expect(temperatureSupported("bedrock", "anthropic.claude-opus-4-7", false)).toBe(false);
  });
  it("still allows temperature on Opus/Sonnet 4.6 and earlier (params not removed)", () => {
    expect(temperatureSupported("anthropic", "claude-opus-4-6", false)).toBe(true);
    expect(temperatureSupported("anthropic", "claude-opus-4-5", false)).toBe(true);
    expect(temperatureSupported("bedrock", "eu.anthropic.claude-sonnet-4-6", false)).toBe(true);
  });
});
