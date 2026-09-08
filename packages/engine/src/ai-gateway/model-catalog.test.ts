// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { providerConfigs, type ModelCapabilities } from "./model-catalog.js";
import {
  reasoningCapableFallback,
  reasoningAlwaysOnFallback,
  reasoningControlFallback,
  reasoningLevelsFallback,
  temperatureRejectedFallback,
  cacheCapableFallback,
} from "./config.js";
import { visionCapableFallback } from "./vision.js";

/** [provider, modelId, capabilities] for every catalogued row. */
const ALL: Array<[string, string, ModelCapabilities]> = Object.entries(providerConfigs).flatMap(
  ([provider, cfg]) =>
    Object.entries(cfg.models).map(
      ([modelId, caps]) => [provider, modelId, caps] as [string, string, ModelCapabilities],
    ),
);

describe("model catalog integrity", () => {
  it("every tier model exists in the catalog", () => {
    for (const [provider, cfg] of Object.entries(providerConfigs)) {
      for (const modelId of Object.values(cfg.tiers)) {
        expect(cfg.models, `${provider} tier model ${modelId}`).toHaveProperty(modelId);
      }
    }
  });

  it("no bedrock tier defaults to an Anthropic model", () => {
    // Claude on Bedrock sits behind a per-account use-case form. A tier pointing
    // there fails closed for accounts without the grant, and the service jobs
    // (title, memory, governance) have no per-instance override to escape it.
    for (const [tier, modelId] of Object.entries(providerConfigs.bedrock.tiers)) {
      expect(modelId, `bedrock ${tier} tier`).not.toMatch(/anthropic/);
    }
  });

  it("the bedrock standard tier supports caching and vision", () => {
    // The supervisor turn resends a long system prompt every turn and may carry
    // an inbound image; a model missing either degrades silently, not loudly.
    const standard = providerConfigs.bedrock.models[providerConfigs.bedrock.tiers.standard];
    expect(standard.cache, "bedrock standard tier cache").toBe(true);
    expect(standard.vision, "bedrock standard tier vision").toBe(true);
  });

  it("the bedrock heavy tier is reasoning-capable", () => {
    // Its only consumer is the prompt-injection gate, which a non-reasoning
    // model misses (see governance/governance-ai.ts).
    const heavy = providerConfigs.bedrock.models[providerConfigs.bedrock.tiers.heavy];
    expect(heavy.reasoning, "bedrock heavy tier reasoning").toBe(true);
  });

  it("no model is priced without capability fields", () => {
    for (const [provider, modelId, caps] of ALL) {
      const where = `${provider}/${modelId}`;
      expect(caps.input, `${where} input`).toBeGreaterThan(0);
      expect(caps.output, `${where} output`).toBeGreaterThan(0);
      expect(typeof caps.reasoning, `${where} reasoning`).toBe("boolean");
      expect(typeof caps.vision, `${where} vision`).toBe("boolean");
      expect(typeof caps.temperature, `${where} temperature`).toBe("boolean");
      expect(typeof caps.cache, `${where} cache`).toBe("boolean");
    }
  });

  it("always-on reasoning implies reasoning-capable", () => {
    for (const [provider, modelId, caps] of ALL) {
      if (caps.reasoningAlwaysOn) {
        expect(caps.reasoning, `${provider}/${modelId} alwaysOn without reasoning`).toBe(true);
      }
    }
  });

  it("reasoningControl is present exactly when reasoning is true", () => {
    for (const [provider, modelId, caps] of ALL) {
      expect(caps.reasoningControl !== undefined, `${provider}/${modelId} control⟺reasoning`).toBe(caps.reasoning);
    }
  });

  it("reasoningLevels is present exactly when reasoning is true, non-empty, includes medium", () => {
    for (const [provider, modelId, caps] of ALL) {
      expect(caps.reasoningLevels !== undefined, `${provider}/${modelId} levels⟺reasoning`).toBe(caps.reasoning);
      if (caps.reasoningLevels) {
        expect(caps.reasoningLevels.length, `${provider}/${modelId} empty levels`).toBeGreaterThan(0);
        expect(caps.reasoningLevels, `${provider}/${modelId} missing medium`).toContain("medium");
      }
    }
  });
});

// Behaviour-preserving migration guard: capability values were seeded from the
// historical regex heuristics, so every catalogued row must still agree with its
// fallback. When a follow-up live-verifies a divergence (the heuristic was wrong),
// update BOTH the catalog row and the fallback regex — or exempt that row here.
describe("catalog capabilities match the regex fallback (migration guard)", () => {
  it.each(ALL)("%s/%s", (provider, modelId, caps) => {
    expect(caps.reasoning).toBe(reasoningCapableFallback(provider, modelId));
    expect(caps.reasoningAlwaysOn ?? false).toBe(reasoningAlwaysOnFallback(modelId));
    expect(caps.reasoningControl).toBe(reasoningControlFallback(provider, modelId));
    expect(caps.reasoningLevels ?? []).toEqual(reasoningLevelsFallback(provider, modelId));
    expect(caps.temperature).toBe(!temperatureRejectedFallback(provider, modelId));
    expect(caps.cache).toBe(cacheCapableFallback(provider, modelId));
    expect(caps.vision).toBe(visionCapableFallback(modelId));
  });
});
