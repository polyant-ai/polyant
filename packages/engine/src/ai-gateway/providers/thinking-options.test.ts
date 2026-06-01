// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildAnthropicThinkingOptions } from "./anthropic.js";
import { buildOpenAIReasoningOptions } from "./openai.js";

describe("buildAnthropicThinkingOptions", () => {
  it("returns an enabled thinking block with a positive token budget", () => {
    const opts = buildAnthropicThinkingOptions();
    expect(opts.thinking.type).toBe("enabled");
    expect(opts.thinking.budgetTokens).toBeGreaterThan(0);
  });

  it("is shaped so it can be spread into providerOptions.anthropic", () => {
    const providerOptions = { anthropic: { foo: "bar", ...buildAnthropicThinkingOptions() } };
    expect(providerOptions.anthropic).toMatchObject({
      foo: "bar",
      thinking: { type: "enabled" },
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
