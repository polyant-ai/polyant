// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { resolveModel, estimateCost, estimateSttCost, providerConfigs, isThinkingCapable } from "./config.js";

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

  it("returns 0 for unknown model", () => {
    expect(estimateCost("openai", "gpt-5-turbo", 1000, 1000)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCost("openai", "gpt-4o", 0, 0)).toBe(0);
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
        expect(provider.costPerMillionTokens).toHaveProperty(model);
        const pricing = provider.costPerMillionTokens[model];
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
      ["anthropic.claude-opus-4-20250514-v1:0", true],
      // Cross-region inference profiles (the form actually invoked) must still match.
      ["eu.anthropic.claude-sonnet-4-6", true],
      ["eu.anthropic.claude-opus-4-8", true],
      ["global.anthropic.claude-sonnet-4-5-20250929-v1:0", true],
      ["anthropic.claude-3-5-haiku-20241022-v1:0", false],
      ["eu.amazon.nova-lite-v1:0", false],
      ["amazon.nova-lite-v1:0", false],
      ["amazon.nova-pro-v1:0", false],
      ["meta.llama4-scout-17b-instruct-v1:0", false],
      ["meta.llama3-1-70b-instruct-v1:0", false],
      ["qwen.qwen3-32b-v1:0", false],
      ["mistral.mistral-large-2402-v1:0", false],
    ])("bedrock/%s -> %s", (model, expected) => {
      expect(isThinkingCapable("bedrock", model)).toBe(expected);
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
