// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll } from "vitest";
import { buildCompatibleReasoningOptions } from "./openai-compatible-reasoning.js";
import { registerProviderConfig } from "../model-catalog.js";

/**
 * The four off-switch shapes and the one on-switch, exercised against a
 * REGISTERED test provider rather than against a shipped catalog.
 *
 * On purpose: what is being tested is the mechanism — that the wire payload is
 * read out of catalog data — and pinning it to a real provider's rows would make
 * this test fail the day that provider's prices or levels are corrected, which
 * is the opposite of what it is for. The shipped rows are asserted separately,
 * where the data lives.
 */
const P = "test-compatible-provider";

beforeAll(() => {
  registerProviderConfig(P, {
    wireDialect: "openai-compatible",
    defaultReasoningOff: { via: "effort-none" },
    tiers: { fast: "kwarg-off", standard: "kwarg-off", heavy: "kwarg-off" },
    models: {
      // Inherits the provider default: reasoning_effort: "none".
      "provider-default-off": { input: 1, output: 1, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      // Overrides it with a chat-template kwarg.
      "kwarg-off": { input: 1, output: 1, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], reasoningOff: { via: "template-kwarg", kwarg: "enable_thinking", value: false }, vision: false, temperature: true, cache: false },
      // A differently-named kwarg with a string value (MiniMax's shape).
      "mode-off": { input: 1, output: 1, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], reasoningOff: { via: "template-kwarg", kwarg: "thinking_mode", value: "disabled" }, vision: false, temperature: true, cache: false },
      // Off by default: needs a kwarg to switch ON, and nothing to stay off.
      "needs-on": { input: 1, output: 1, reasoning: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], reasoningOn: { via: "template-kwarg", kwarg: "thinking", value: true }, vision: false, temperature: true, cache: false },
      // No off at all.
      "always-on": { input: 1, output: 1, reasoning: true, reasoningAlwaysOn: true, reasoningControl: "effort", reasoningLevels: ["low", "medium", "high"], vision: false, temperature: true, cache: false },
      // Publishes a set without `medium`, so the clamp cannot fall back to it.
      "no-medium": { input: 1, output: 1, reasoning: true, reasoningControl: "effort", reasoningLevels: ["high", "max"], vision: false, temperature: true, cache: false },
    },
  });
});

const on = (modelId: string, level = "medium") =>
  buildCompatibleReasoningOptions({ provider: P, modelId, thinking: true, level });
const off = (modelId: string) =>
  buildCompatibleReasoningOptions({ provider: P, modelId, thinking: false, level: "medium" });

describe("thinking ON", () => {
  it("sends the clamped effort and nothing else", () => {
    expect(on("provider-default-off", "high")).toEqual({ reasoningEffort: "high" });
  });

  it("adds the on-switch kwarg for a model that does not reason by default", () => {
    expect(on("needs-on")).toEqual({
      reasoningEffort: "medium",
      chat_template_kwargs: { thinking: true },
    });
  });

  it("never sends an off-switch while thinking is on", () => {
    for (const model of ["kwarg-off", "mode-off", "always-on"]) {
      expect(on(model), model).toEqual({ reasoningEffort: "medium" });
    }
  });
});

describe("thinking OFF", () => {
  it("falls back to the provider's off-switch when the model declares none", () => {
    expect(off("provider-default-off")).toEqual({ reasoningEffort: "none" });
  });

  it("prefers the model's own off-switch over the provider's", () => {
    expect(off("kwarg-off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(off("mode-off")).toEqual({ chat_template_kwargs: { thinking_mode: "disabled" } });
  });

  it("sends nothing for a model whose OFF is the absence of the on-switch", () => {
    // `needs-on` declares only `reasoningOn`, so off is not sending it. Sending
    // the provider default (`reasoning_effort: "none"`) instead would be a
    // parameter this model never asked for.
    expect(off("needs-on")).toEqual({});
  });

  it("sends nothing for a model with no off at all", () => {
    // The kwarg would be ignored, so it is noise on the wire — and in a captured
    // debug payload it reads as if the gateway had switched something off.
    expect(off("always-on")).toEqual({});
  });
});

describe("effort clamping", () => {
  it("clamps an out-of-range level to one the model publishes", () => {
    expect(on("no-medium", "medium")).toEqual({ reasoningEffort: "medium" });
  });
});
