// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { providerConfigs, type ModelCapabilities } from "./model-catalog.js";
import {
  reasoningCapableFallback,
  reasoningAlwaysOnFallback,
  reasoningAdaptiveFallback,
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
});

// Behaviour-preserving migration guard: capability values were seeded from the
// historical regex heuristics, so every catalogued row must still agree with its
// fallback. When a follow-up live-verifies a divergence (the heuristic was wrong),
// update BOTH the catalog row and the fallback regex — or exempt that row here.
describe("catalog capabilities match the regex fallback (migration guard)", () => {
  it.each(ALL)("%s/%s", (provider, modelId, caps) => {
    expect(caps.reasoning).toBe(reasoningCapableFallback(provider, modelId));
    expect(caps.reasoningAlwaysOn ?? false).toBe(reasoningAlwaysOnFallback(modelId));
    expect(caps.reasoningAdaptive ?? false).toBe(reasoningAdaptiveFallback(provider, modelId));
    expect(caps.temperature).toBe(!temperatureRejectedFallback(provider, modelId));
    expect(caps.cache).toBe(cacheCapableFallback(provider, modelId));
    expect(caps.vision).toBe(visionCapableFallback(modelId));
  });
});
