// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildAnthropicThinkingOptions } from "./anthropic.js";
import { buildOpenAIReasoningOptions } from "./openai.js";
import { buildBedrockReasoningOptions } from "./bedrock.js";

describe("buildAnthropicThinkingOptions", () => {
  it("legacy models: enabled block with a level-scaled token budget", () => {
    const low = buildAnthropicThinkingOptions("low", false) as { thinking: { type: string; budgetTokens: number } };
    const high = buildAnthropicThinkingOptions("high", false) as { thinking: { type: string; budgetTokens: number } };
    expect(low.thinking.type).toBe("enabled");
    expect(low.thinking.budgetTokens).toBeGreaterThan(0);
    expect(low.thinking.budgetTokens).toBeLessThan(high.thinking.budgetTokens);
  });

  it("adaptive models: adaptive block + effort (rejects the legacy shape live)", () => {
    const opts = buildAnthropicThinkingOptions("high", true) as { thinking: { type: string }; effort: string };
    expect(opts.thinking.type).toBe("adaptive");
    expect(opts.effort).toBe("high");
    expect(opts).not.toHaveProperty("thinking.budgetTokens");
  });

  it("normalises an unknown level to medium", () => {
    const opts = buildAnthropicThinkingOptions("bogus", true) as { effort: string };
    expect(opts.effort).toBe("medium");
  });

  it("is shaped so it can be spread into providerOptions.anthropic", () => {
    const providerOptions = { anthropic: { foo: "bar", ...buildAnthropicThinkingOptions("medium", false) } };
    expect(providerOptions.anthropic).toMatchObject({ foo: "bar", thinking: { type: "enabled" } });
  });
});

describe("buildOpenAIReasoningOptions", () => {
  it("passes the requested level through as reasoningEffort", () => {
    expect(buildOpenAIReasoningOptions("low").reasoningEffort).toBe("low");
    expect(buildOpenAIReasoningOptions("high").reasoningEffort).toBe("high");
  });

  it("normalises an unknown level to medium", () => {
    expect(buildOpenAIReasoningOptions("bogus").reasoningEffort).toBe("medium");
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

  it("adaptive control → adaptive block + effort (Opus 4.7/4.8, Sonnet 5)", () => {
    const { reasoningConfig } = buildBedrockReasoningOptions("low", "adaptive");
    expect(reasoningConfig).toEqual({ type: "adaptive", maxReasoningEffort: "low" });
  });

  it("effort control → enabled + effort (not a budget; gpt-oss)", () => {
    const { reasoningConfig } = buildBedrockReasoningOptions("high", "effort");
    expect(reasoningConfig).toEqual({ type: "enabled", maxReasoningEffort: "high" });
  });

  it("normalises an unknown level to medium", () => {
    expect(buildBedrockReasoningOptions("bogus", "effort").reasoningConfig).toEqual({
      type: "enabled",
      maxReasoningEffort: "medium",
    });
  });

  it("is shaped so it can be spread into providerOptions.bedrock", () => {
    const providerOptions = { bedrock: { foo: "bar", ...buildBedrockReasoningOptions("medium", "effort") } };
    expect(providerOptions.bedrock).toMatchObject({
      foo: "bar",
      reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" },
    });
  });
});
