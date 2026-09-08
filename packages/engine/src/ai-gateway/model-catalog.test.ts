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
  cacheOnToolMessagesFallback,
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
    // Its consumers are the semantic governance gates (prompt-injection, PII,
    // topic guardrail), each of which parses a JSON verdict and fails OPEN — so
    // a non-reasoning model there does not error, it silently stops gating.
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
    expect(caps.cacheOnToolMessages ?? true).toBe(cacheOnToolMessagesFallback(provider, modelId));
    expect(caps.vision).toBe(visionCapableFallback(modelId));
  });
});

describe("the two Bedrock cache fallbacks agree on what Nova is", () => {
  // They are consulted for ids with no catalog row, and a disagreement there is
  // not a style issue: an id counted as cache-capable but not as Nova is told to
  // place a `cachePoint` on a tool message, which is exactly the 400 the
  // tool-message gate exists to prevent — with no catalog row to correct it.
  it.each([
    "eu.amazon.nova-3-pro-v1:0",
    "us.amazon.nova-lite-v1:0",
    "amazon.nova-micro-v1:0",
    "nova-something-unprefixed",
  ])("%s is Nova to both gates", (modelId) => {
    expect(cacheCapableFallback("bedrock", modelId), `${modelId} cache-capable`).toBe(true);
    expect(cacheOnToolMessagesFallback("bedrock", modelId), `${modelId} tool-message cache`).toBe(false);
  });

  it("a cache-capable non-Anthropic Bedrock id is never allowed a tool-message marker", () => {
    for (const [provider, modelId] of ALL.map(([p, m]) => [p, m] as const)) {
      if (provider !== "bedrock") continue;
      if (!cacheCapableFallback(provider, modelId)) continue;
      if (/anthropic/.test(modelId)) continue;
      expect(cacheOnToolMessagesFallback(provider, modelId), modelId).toBe(false);
    }
  });
});
