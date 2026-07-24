// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import {
  generateWithReplay,
  MAX_REGENERATIONS,
  EMPTY_SPEND,
  addPassSpend,
  type ResponseGeneratedOutcome,
} from "./response-replay.js";
import type { CostBreakdown } from "../ai-gateway/types.js";

const clean: ResponseGeneratedOutcome = { summaries: [] };
const wantRegen: ResponseGeneratedOutcome = { summaries: [], regenerate: { reason: "dirty" } };

describe("generateWithReplay", () => {
  it("returns the first result when no hook asks to regenerate", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const { result, finalText, outcome } = await generateWithReplay({
      generate, evaluate: async () => clean, maxRegenerations: 5,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(0);
    expect(result.text).toBe("gen0");
    expect(finalText).toBe("gen0");
    expect(outcome).toBe(clean);
  });

  it("regenerates while requested, passing the incremented count", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const evaluate = vi.fn(async (_t: string, r: number) => (r < 2 ? wantRegen : clean));
    const { result, finalText } = await generateWithReplay({ generate, evaluate, maxRegenerations: 5 });
    expect(generate.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    expect(result.text).toBe("gen2");
    expect(finalText).toBe("gen2");
  });

  it("stops at maxRegenerations even if the hook keeps asking", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const { result } = await generateWithReplay({
      generate, evaluate: async () => wantRegen, maxRegenerations: 2,
    });
    expect(generate).toHaveBeenCalledTimes(3); // initial + 2 replays
    expect(result.text).toBe("gen2");
  });

  it("applies replaceResponse when no regenerate is requested", async () => {
    const generate = vi.fn(async () => ({ text: "raw" }));
    const { finalText } = await generateWithReplay({
      generate,
      evaluate: async () => ({ summaries: [], replace: { message: "clean" } }),
      maxRegenerations: 5,
    });
    expect(finalText).toBe("clean");
  });

  it("prefers regenerate over replace within the same pass", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const evaluate = vi.fn(async (_t: string, r: number) =>
      r === 0 ? { summaries: [], regenerate: { reason: "x" }, replace: { message: "ignored" } } : clean,
    );
    const { finalText } = await generateWithReplay({ generate, evaluate, maxRegenerations: 5 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(finalText).toBe("gen1");
  });

  it("delivers the raw last output (not replace) when the cap is hit with regenerate still requested", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    // Every pass asks to regenerate AND offers a replace — on cap exhaustion the replay
    // is denied, so regenerate still "wins" and the raw last text ships, not the replace.
    const { result, finalText } = await generateWithReplay({
      generate,
      evaluate: async () => ({ summaries: [], regenerate: { reason: "x" }, replace: { message: "should-not-ship" } }),
      maxRegenerations: 2,
    });
    expect(result.text).toBe("gen2");
    expect(finalText).toBe("gen2");
  });

  it("does not regenerate when the signal is already aborted", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const ac = new AbortController();
    ac.abort();
    await generateWithReplay({ generate, evaluate: async () => wantRegen, maxRegenerations: 5, abortSignal: ac.signal });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("exports a hard cap of 5", () => {
    expect(MAX_REGENERATIONS).toBe(5);
  });
});

describe("addPassSpend", () => {
  const cost = (n: number): CostBreakdown => ({
    input: n, cache: n, cacheRead: n, cacheWrite: n, output: n, total: n,
  });
  const pass = (n: number) => ({
    durationMs: n,
    toolBuildingMs: n,
    usage: { promptTokens: n, completionTokens: n, cachedInputTokens: n, cacheCreationInputTokens: n },
    cost: cost(n),
  });

  it("returns a single pass unchanged from the empty accumulator", () => {
    const spend = addPassSpend(EMPTY_SPEND, pass(3));
    expect(spend).toEqual({
      llmCallMs: 3, toolBuildingMs: 3, promptTokens: 3, completionTokens: 3,
      cachedInputTokens: 3, cacheCreationInputTokens: 3, cost: cost(3),
    });
    expect(EMPTY_SPEND.llmCallMs).toBe(0); // non-mutating
  });

  it("sums spend across passes (tokens, latency, and cost fields)", () => {
    const spend = addPassSpend(addPassSpend(EMPTY_SPEND, pass(2)), pass(5));
    expect(spend).toEqual({
      llmCallMs: 7, toolBuildingMs: 7, promptTokens: 7, completionTokens: 7,
      cachedInputTokens: 7, cacheCreationInputTokens: 7, cost: cost(7),
    });
  });

  it("keeps the accumulated cost when a pass reports no cost", () => {
    const withCost = addPassSpend(EMPTY_SPEND, pass(4));
    const noCost = addPassSpend(withCost, { durationMs: 1, toolBuildingMs: 1, usage: { promptTokens: 1, completionTokens: 1 } });
    expect(noCost.cost).toEqual(cost(4));
    expect(noCost.promptTokens).toBe(5);
    expect(noCost.cachedInputTokens).toBe(4); // undefined cache fields default to 0
  });
});
