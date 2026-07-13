// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildAnthropicThinkingOptions } from "./anthropic.js";
import { buildOpenAIReasoningOptions } from "./openai.js";
import { buildBedrockReasoningOptions } from "./bedrock.js";

describe("buildAnthropicThinkingOptions", () => {
  it("uses a manual token budget for older Claude models", () => {
    const opts = buildAnthropicThinkingOptions("claude-sonnet-4-6", "medium") as {
      thinking: { type: string; budgetTokens: number };
    };
    expect(opts.thinking.type).toBe("enabled");
    expect(opts.thinking.budgetTokens).toBeGreaterThan(0);
  });

  it("uses adaptive thinking + effort for the Claude-5 generation (rejects budget_tokens)", () => {
    const opts = buildAnthropicThinkingOptions("claude-sonnet-5", "high");
    expect(opts).toEqual({ thinking: { type: "adaptive" }, effort: "high" });
  });

  it("normalises an unknown level to medium effort (adaptive path)", () => {
    expect(buildAnthropicThinkingOptions("claude-opus-4-8", "bogus")).toEqual({
      thinking: { type: "adaptive" },
      effort: "medium",
    });
  });

  it("is shaped so it can be spread into providerOptions.anthropic", () => {
    const providerOptions = { anthropic: { foo: "bar", ...buildAnthropicThinkingOptions("claude-sonnet-5", "medium") } };
    expect(providerOptions.anthropic).toMatchObject({
      foo: "bar",
      thinking: { type: "adaptive" },
      effort: "medium",
    });
  });
});

describe("buildOpenAIReasoningOptions", () => {
  it("returns a reasoning effort the SDK forwards to the provider", () => {
    const opts = buildOpenAIReasoningOptions();
    expect(["low", "medium", "high"]).toContain(opts.reasoningEffort);
  });

  it("is shaped so it can be spread into providerOptions.openai", () => {
    const providerOptions = { openai: { foo: "bar", ...buildOpenAIReasoningOptions() } };
    expect(providerOptions.openai).toMatchObject({ foo: "bar", reasoningEffort: "medium" });
  });
});

describe("buildBedrockReasoningOptions", () => {
  it("maps older Claude to a token budget within Bedrock's [1024, 64000] range", () => {
    const { reasoningConfig } = buildBedrockReasoningOptions("eu.anthropic.claude-sonnet-4-6", "medium");
    expect(reasoningConfig.type).toBe("enabled");
    expect(reasoningConfig.budgetTokens).toBeGreaterThanOrEqual(1024);
    expect(reasoningConfig.budgetTokens).toBeLessThanOrEqual(64000);
    expect(reasoningConfig).not.toHaveProperty("maxReasoningEffort");
  });

  it("scales the older-Claude budget with the level (low < medium < high)", () => {
    const low = buildBedrockReasoningOptions("anthropic.claude-sonnet-4-6", "low").reasoningConfig.budgetTokens as number;
    const medium = buildBedrockReasoningOptions("anthropic.claude-sonnet-4-6", "medium").reasoningConfig.budgetTokens as number;
    const high = buildBedrockReasoningOptions("anthropic.claude-sonnet-4-6", "high").reasoningConfig.budgetTokens as number;
    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  it("maps the Claude-5 generation to adaptive thinking + effort (rejects budget_tokens)", () => {
    // The SDK serialises this to thinking:{type:"adaptive"} + output_config:{effort}.
    for (const modelId of ["anthropic.claude-sonnet-5", "us.anthropic.claude-opus-4-8", "anthropic.claude-opus-4-7"]) {
      const { reasoningConfig } = buildBedrockReasoningOptions(modelId, "high");
      expect(reasoningConfig).toEqual({ type: "adaptive", maxReasoningEffort: "high" });
      expect(reasoningConfig).not.toHaveProperty("budgetTokens");
    }
  });

  it("maps gpt-oss to an effort level (not a budget)", () => {
    const { reasoningConfig } = buildBedrockReasoningOptions("openai.gpt-oss-120b-1:0", "high");
    expect(reasoningConfig).toEqual({ type: "enabled", maxReasoningEffort: "high" });
  });

  it("normalises an unknown level to medium", () => {
    expect(buildBedrockReasoningOptions("openai.gpt-oss-120b-1:0", "bogus").reasoningConfig).toEqual({
      type: "enabled",
      maxReasoningEffort: "medium",
    });
  });

  it("is shaped so it can be spread into providerOptions.bedrock", () => {
    const providerOptions = { bedrock: { foo: "bar", ...buildBedrockReasoningOptions("openai.gpt-oss-120b-1:0", "medium") } };
    expect(providerOptions.bedrock).toMatchObject({
      foo: "bar",
      reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" },
    });
  });
});
