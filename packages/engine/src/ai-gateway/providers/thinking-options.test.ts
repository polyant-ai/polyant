// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildAnthropicThinkingOptions } from "./anthropic.js";
import { buildOpenAIReasoningOptions } from "./openai.js";
import { buildBedrockReasoningOptions } from "./bedrock.js";

// NOTE: the builders FORWARD the reasoning level as-is (adaptive/effort paths) —
// the ai-gateway (resolveReasoningLevel) is the single place that clamps a
// requested level to the model's catalog reasoningLevels. Only the budget path
// maps to a fixed low/medium/high token preset.

describe("buildAnthropicThinkingOptions", () => {
  it("legacy (budget): enabled block with a level-scaled token budget", () => {
    const low = buildAnthropicThinkingOptions("low", false) as { thinking: { type: string; budgetTokens: number } };
    const high = buildAnthropicThinkingOptions("high", false) as { thinking: { type: string; budgetTokens: number } };
    expect(low.thinking.type).toBe("enabled");
    expect(low.thinking.budgetTokens).toBeGreaterThan(0);
    expect(low.thinking.budgetTokens).toBeLessThan(high.thinking.budgetTokens);
  });

  it("budget maps an out-of-preset level to the medium preset", () => {
    const bogus = buildAnthropicThinkingOptions("bogus", false) as { thinking: { budgetTokens: number } };
    const medium = buildAnthropicThinkingOptions("medium", false) as { thinking: { budgetTokens: number } };
    expect(bogus.thinking.budgetTokens).toBe(medium.thinking.budgetTokens);
  });

  it("adaptive forwards the level as-is (incl. xhigh/max — gateway clamps, not the builder)", () => {
    expect(buildAnthropicThinkingOptions("high", true)).toEqual({ thinking: { type: "adaptive" }, effort: "high" });
    expect(buildAnthropicThinkingOptions("xhigh", true)).toEqual({ thinking: { type: "adaptive" }, effort: "xhigh" });
    expect(buildAnthropicThinkingOptions("max", true)).toEqual({ thinking: { type: "adaptive" }, effort: "max" });
  });

  it("is shaped so it can be spread into providerOptions.anthropic", () => {
    const providerOptions = { anthropic: { foo: "bar", ...buildAnthropicThinkingOptions("medium", false) } };
    expect(providerOptions.anthropic).toMatchObject({ foo: "bar", thinking: { type: "enabled" } });
  });
});

describe("buildOpenAIReasoningOptions", () => {
  it("forwards the level as-is (gateway clamps)", () => {
    expect(buildOpenAIReasoningOptions("low").reasoningEffort).toBe("low");
    expect(buildOpenAIReasoningOptions("high").reasoningEffort).toBe("high");
    expect(buildOpenAIReasoningOptions("xhigh").reasoningEffort).toBe("xhigh");
  });

  it("is shaped so it can be spread into providerOptions.openai", () => {
    const providerOptions = { openai: { foo: "bar", ...buildOpenAIReasoningOptions("medium") } };
    expect(providerOptions.openai).toMatchObject({ foo: "bar", reasoningEffort: "medium" });
  });
});

describe("buildBedrockReasoningOptions", () => {
  it("budget control → a token budget in [1024, 64000], scaled by level", () => {
    const { reasoningConfig } = buildBedrockReasoningOptions("medium", "budget");
    expect(reasoningConfig.type).toBe("enabled");
    expect(reasoningConfig.budgetTokens).toBeGreaterThanOrEqual(1024);
    expect(reasoningConfig.budgetTokens).toBeLessThanOrEqual(64000);
    expect(reasoningConfig).not.toHaveProperty("maxReasoningEffort");
    const low = buildBedrockReasoningOptions("low", "budget").reasoningConfig.budgetTokens as number;
    const high = buildBedrockReasoningOptions("high", "budget").reasoningConfig.budgetTokens as number;
    expect(low).toBeLessThan(high);
  });

  it("budget maps an out-of-preset level to the medium preset", () => {
    const bogus = buildBedrockReasoningOptions("bogus", "budget").reasoningConfig.budgetTokens;
    const medium = buildBedrockReasoningOptions("medium", "budget").reasoningConfig.budgetTokens;
    expect(bogus).toBe(medium);
  });

  it("adaptive control → adaptive block, forwards the level (incl. xhigh/max)", () => {
    expect(buildBedrockReasoningOptions("low", "adaptive").reasoningConfig).toEqual({ type: "adaptive", maxReasoningEffort: "low" });
    expect(buildBedrockReasoningOptions("max", "adaptive").reasoningConfig).toEqual({ type: "adaptive", maxReasoningEffort: "max" });
  });

  it("effort control → enabled + effort, forwards the level (gpt-oss)", () => {
    expect(buildBedrockReasoningOptions("high", "effort").reasoningConfig).toEqual({ type: "enabled", maxReasoningEffort: "high" });
  });

  it("is shaped so it can be spread into providerOptions.bedrock", () => {
    const providerOptions = { bedrock: { foo: "bar", ...buildBedrockReasoningOptions("medium", "effort") } };
    expect(providerOptions.bedrock).toMatchObject({
      foo: "bar",
      reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" },
    });
  });
});
