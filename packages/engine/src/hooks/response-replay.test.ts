// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { generateWithReplay, MAX_REGENERATIONS, type ResponseGeneratedOutcome } from "./response-replay.js";

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
