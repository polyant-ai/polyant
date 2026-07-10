// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

// langsmith is an optional runtime dep that's not installed in this checkout.
// We mock the wrapper it exports so importing base.ts (which transitively
// imports langsmith.ts) doesn't blow up during test runs.
vi.mock("../langsmith.js", () => ({
  tracedGenerateText: vi.fn(),
  tracedStreamText: vi.fn(),
  buildLangSmithProviderOptions: vi.fn(),
}));

import type { ModelMessage } from "ai";
import { buildSteps, aggregateReasoning, serializeTools, createProvider, normalizeStrictConversation } from "./base.js";
import { tracedGenerateText, tracedStreamText } from "../langsmith.js";

// safeTokens and aggregateStepUsage are not exported, so we test them
// indirectly by re-implementing the same logic in a testable way.
// However, since they're module-scoped, we import the module and use
// a workaround: we'll test via the createProvider function or extract them.

// Since safeTokens and aggregateStepUsage are not exported, we replicate
// the exact logic here and test it. If the source changes, these tests
// should be updated accordingly.

/** Safely coerce a token count to a non-negative integer. */
const safeTokens = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

/** Aggregate usage from individual steps. */
function aggregateStepUsage(
  steps: { usage?: { promptTokens?: number; completionTokens?: number } }[],
): { promptTokens: number; completionTokens: number } {
  let prompt = 0;
  let completion = 0;
  for (const step of steps) {
    if (step.usage) {
      prompt += safeTokens(step.usage.promptTokens);
      completion += safeTokens(step.usage.completionTokens);
    }
  }
  return { promptTokens: prompt, completionTokens: completion };
}

describe("safeTokens", () => {
  it("returns 0 for undefined", () => {
    expect(safeTokens(undefined)).toBe(0);
  });

  it("returns 0 for null", () => {
    expect(safeTokens(null)).toBe(0);
  });

  it("returns 0 for NaN", () => {
    expect(safeTokens(NaN)).toBe(0);
  });

  it("returns 0 for Infinity", () => {
    expect(safeTokens(Infinity)).toBe(0);
  });

  it("returns 0 for -Infinity", () => {
    expect(safeTokens(-Infinity)).toBe(0);
  });

  it("returns 0 for negative numbers", () => {
    expect(safeTokens(-5)).toBe(0);
  });

  it("returns the value for valid positive numbers", () => {
    expect(safeTokens(100)).toBe(100);
  });

  it("rounds fractional numbers", () => {
    expect(safeTokens(10.7)).toBe(11);
    expect(safeTokens(10.3)).toBe(10);
  });

  it("returns 0 for non-numeric strings", () => {
    expect(safeTokens("abc")).toBe(0);
  });

  it("coerces numeric strings", () => {
    expect(safeTokens("42")).toBe(42);
  });

  it("returns 0 for empty string", () => {
    expect(safeTokens("")).toBe(0);
  });
});

describe("aggregateStepUsage", () => {
  it("sums across multiple steps correctly", () => {
    const steps = [
      { usage: { promptTokens: 100, completionTokens: 50 } },
      { usage: { promptTokens: 200, completionTokens: 75 } },
      { usage: { promptTokens: 300, completionTokens: 25 } },
    ];
    const result = aggregateStepUsage(steps);
    expect(result.promptTokens).toBe(600);
    expect(result.completionTokens).toBe(150);
  });

  it("handles empty array", () => {
    const result = aggregateStepUsage([]);
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it("handles steps with no usage property", () => {
    const steps = [{}, { usage: { promptTokens: 100, completionTokens: 50 } }];
    const result = aggregateStepUsage(steps);
    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(50);
  });

  it("handles steps with undefined token values", () => {
    const steps = [
      { usage: { promptTokens: undefined, completionTokens: 50 } },
      { usage: { promptTokens: 200, completionTokens: undefined } },
    ];
    const result = aggregateStepUsage(steps as any);
    expect(result.promptTokens).toBe(200);
    expect(result.completionTokens).toBe(50);
  });

  it("handles steps with NaN token values", () => {
    const steps = [
      { usage: { promptTokens: NaN, completionTokens: 50 } },
      { usage: { promptTokens: 100, completionTokens: NaN } },
    ];
    const result = aggregateStepUsage(steps);
    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(50);
  });

  it("handles single step", () => {
    const steps = [{ usage: { promptTokens: 500, completionTokens: 200 } }];
    const result = aggregateStepUsage(steps);
    expect(result.promptTokens).toBe(500);
    expect(result.completionTokens).toBe(200);
  });
});

describe("buildSteps", () => {
  it("returns empty array when no SDK steps", () => {
    expect(buildSteps([], 100)).toEqual([]);
  });

  it("maps SDK fields into StepDetail with proportional duration", () => {
    const steps = buildSteps(
      [
        {
          stepType: "initial",
          text: "intermediate",
          toolCalls: [{ toolCallId: "c1", toolName: "search", args: { q: "x" } }],
          toolResults: [{ toolCallId: "c1", result: "ok" }],
          finishReason: "tool-calls",
          usage: { promptTokens: 10, completionTokens: 5 },
        },
        {
          stepType: "continue",
          text: "final",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 20 },
        },
      ],
      400,
    );

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      index: 0,
      stepType: "initial",
      text: "intermediate",
      finishReason: "tool-calls",
      durationMs: 200,
      promptTokens: 10,
      completionTokens: 5,
    });
    expect(steps[0].toolCalls).toEqual([
      { toolCallId: "c1", toolName: "search", args: { q: "x" } },
    ]);
    expect(steps[0].toolResults).toEqual([{ toolCallId: "c1", result: "ok" }]);
    expect(steps[1]).toMatchObject({
      index: 1,
      stepType: "continue",
      text: "final",
      finishReason: "stop",
      durationMs: 200,
    });
    expect(steps[1].toolCalls).toEqual([]);
    expect(steps[1].toolResults).toBeUndefined();
  });

  it("normalises reasoningDetails per step (text+signature, redacted, drops unknowns)", () => {
    const steps = buildSteps(
      [
        {
          stepType: "initial",
          text: "x",
          toolCalls: [],
          finishReason: "stop",
          reasoningDetails: [
            { type: "text", text: "th1", signature: "s1" },
            { type: "text", text: "th2" },
            { type: "redacted", data: "blob" },
            { type: "unknown", text: "ignored" },
          ],
        },
      ],
      100,
    );
    expect(steps[0].reasoning).toEqual([
      { type: "text", text: "th1", signature: "s1" },
      { type: "text", text: "th2" },
      { type: "redacted", data: "blob" },
    ]);
  });

  it("normalises AI SDK v6 reasoning parts (type:'reasoning', signature/redacted from providerMetadata)", () => {
    const steps = buildSteps(
      [
        {
          stepType: "initial",
          text: "x",
          toolCalls: [],
          finishReason: "stop",
          reasoningDetails: [
            { type: "reasoning", text: "th1", providerMetadata: { anthropic: { signature: "s1" } } },
            { type: "reasoning", text: "th2" },
            { type: "reasoning", text: "", providerMetadata: { anthropic: { redactedData: "blob" } } },
            { type: "reasoning" }, // no text, no meta → dropped
          ],
        },
      ],
      100,
    );
    expect(steps[0].reasoning).toEqual([
      { type: "text", text: "th1", signature: "s1" },
      { type: "text", text: "th2" },
      { type: "redacted", data: "blob" },
    ]);
  });

  it("defaults missing optional fields to safe values", () => {
    const steps = buildSteps([{}], 100);
    expect(steps[0]).toMatchObject({
      index: 0,
      stepType: "initial",
      text: "",
      toolCalls: [],
      finishReason: "stop",
      durationMs: 100,
    });
    expect(steps[0].reasoning).toBeUndefined();
    expect(steps[0].toolResults).toBeUndefined();
  });
});

describe("serializeTools (debug capture)", () => {
  it("returns [] for undefined tools", () => {
    expect(serializeTools(undefined)).toEqual([]);
  });

  it("captures name + description + JSON-schema parameters from a zod inputSchema", () => {
    const tools = {
      search: {
        description: "Search the web",
        inputSchema: z.object({ q: z.string() }),
      },
    } as unknown as NonNullable<Parameters<typeof serializeTools>[0]>;

    const result = serializeTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("search");
    expect(result[0].description).toBe("Search the web");
    // zod-to-json-schema produces an object schema with the `q` property.
    expect(result[0].parameters).toMatchObject({ type: "object" });
    expect(JSON.stringify(result[0].parameters)).toContain("\"q\"");
  });

  it("degrades to name (+ description) without throwing when the schema is not convertible", () => {
    const tools = {
      weird: { description: "No real schema", inputSchema: { not: "a zod schema" } },
      bare: {},
    } as unknown as NonNullable<Parameters<typeof serializeTools>[0]>;

    const result = serializeTools(tools);
    expect(result.map((t) => t.name).sort()).toEqual(["bare", "weird"]);
    const weird = result.find((t) => t.name === "weird")!;
    expect(weird.description).toBe("No real schema");
    // No usable parameters → omitted, never throws.
    const bare = result.find((t) => t.name === "bare")!;
    expect(bare.description).toBeUndefined();
  });
});

// Minimal fake result returned by the mocked tracedGenerateText
// minimal shape — SDK return type is complex
const fakeGenerateTextResult = {
  text: "hello",
  steps: [],
  reasoning: undefined,
  totalUsage: { inputTokens: 10, outputTokens: 5 },
};

// Minimal fake result returned by the mocked tracedStreamText.
// chatStream awaits result.text / .totalUsage / .steps / .reasoning as Promises
// and accesses result.textStream / .fullStream synchronously.
// minimal shape — SDK return type is complex
const fakeStreamTextResult = {
  textStream: (async function* () {})(),
  fullStream: (async function* () {})(),
  text: Promise.resolve("hello"),
  totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  steps: Promise.resolve([]),
  reasoning: Promise.resolve(undefined),
};

const baseRequest: import("../types.js").ChatRequest = {
  tier: "standard",
  messages: [{ role: "user", content: "hi" }],
};

describe("createProvider – temperature forwarding", () => {
  it("passes temperature to generateText when set", async () => {
    const generateTextSpy = vi.mocked(tracedGenerateText);
    generateTextSpy.mockClear();
    generateTextSpy.mockResolvedValueOnce(fakeGenerateTextResult as any);

    const adapter = createProvider("test-provider", (_modelId) => ({} as any));
    await adapter.chat({ ...baseRequest, temperature: 0.3 }, "gpt-4o");

    expect(generateTextSpy.mock.calls[0][0]).toMatchObject({ temperature: 0.3 });
  });

  it("omits temperature from generateText when unset", async () => {
    const generateTextSpy = vi.mocked(tracedGenerateText);
    generateTextSpy.mockClear();
    generateTextSpy.mockResolvedValueOnce(fakeGenerateTextResult as any);

    const adapter = createProvider("test-provider", (_modelId) => ({} as any));
    await adapter.chat({ ...baseRequest }, "gpt-4o");

    expect(generateTextSpy.mock.calls[0][0]).not.toHaveProperty("temperature");
  });

  it("passes temperature to streamText when set", async () => {
    const streamTextSpy = vi.mocked(tracedStreamText);
    streamTextSpy.mockClear();
    streamTextSpy.mockResolvedValueOnce(fakeStreamTextResult as any);

    const adapter = createProvider("test-provider", (_modelId) => ({} as any));
    await adapter.chatStream!({ ...baseRequest, temperature: 0.7 }, "gpt-4o");

    expect(streamTextSpy.mock.calls[0][0]).toMatchObject({ temperature: 0.7 });
  });

  it("omits temperature from streamText when unset", async () => {
    const streamTextSpy = vi.mocked(tracedStreamText);
    streamTextSpy.mockClear();
    streamTextSpy.mockResolvedValueOnce(fakeStreamTextResult as any);

    const adapter = createProvider("test-provider", (_modelId) => ({} as any));
    await adapter.chatStream!({ ...baseRequest }, "gpt-4o");

    expect(streamTextSpy.mock.calls[0][0]).not.toHaveProperty("temperature");
  });
});

describe("createProvider – cache gating (cacheConfig)", () => {
  const makeHooks = () => ({
    prepareMessages: vi.fn((input: { system: string | undefined; messages: unknown[]; modelId: string; ttl?: string }) => ({
      system: input.system,
      messages: input.messages,
    })),
    stepMarker: vi.fn(() => ({})),
  });

  it("skips the cache marker AND prepareStep when cacheConfig.enabled is false", async () => {
    const spy = vi.mocked(tracedGenerateText);
    spy.mockClear();
    spy.mockResolvedValueOnce(fakeGenerateTextResult as any);
    const hooks = makeHooks();
    const adapter = createProvider("test-provider", (_m) => ({} as any), hooks as any);

    await adapter.chat({ ...baseRequest, system: "SYS", cacheConfig: { enabled: false, ttl: "1h" } }, "gpt-4o");

    expect(hooks.prepareMessages).not.toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).not.toHaveProperty("prepareStep");
  });

  it("applies the marker + prepareStep and forwards the ttl when enabled", async () => {
    const spy = vi.mocked(tracedGenerateText);
    spy.mockClear();
    spy.mockResolvedValueOnce(fakeGenerateTextResult as any);
    const hooks = makeHooks();
    const adapter = createProvider("test-provider", (_m) => ({} as any), hooks as any);

    await adapter.chat({ ...baseRequest, system: "SYS", cacheConfig: { enabled: true, ttl: "5m" } }, "gpt-4o");

    expect(hooks.prepareMessages).toHaveBeenCalledWith(expect.objectContaining({ ttl: "5m" }));
    expect(spy.mock.calls[0][0]).toHaveProperty("prepareStep");
  });

  it("enables caching (marker + prepareStep) when cacheConfig is omitted — backward compatible", async () => {
    const spy = vi.mocked(tracedGenerateText);
    spy.mockClear();
    spy.mockResolvedValueOnce(fakeGenerateTextResult as any);
    const hooks = makeHooks();
    const adapter = createProvider("test-provider", (_m) => ({} as any), hooks as any);

    await adapter.chat({ ...baseRequest, system: "SYS" }, "gpt-4o");

    expect(hooks.prepareMessages).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toHaveProperty("prepareStep");
  });
});

describe("createProvider – system message folding", () => {
  it("folds a mid-array system message into the top-level system and strips it from messages", async () => {
    const generateTextSpy = vi.mocked(tracedGenerateText);
    generateTextSpy.mockClear();
    generateTextSpy.mockResolvedValueOnce(fakeGenerateTextResult as any);

    const adapter = createProvider("test-provider", (_modelId) => ({}) as any);
    await adapter.chat(
      {
        ...baseRequest,
        system: "A",
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "B" },
          { role: "assistant", content: "ok" },
        ],
      },
      "gpt-4o",
    );

    const call = generateTextSpy.mock.calls[0][0];
    expect(call.system).toBe("A\n\nB");
    expect((call.messages as any[]).every((m) => m.role !== "system")).toBe(true);
    expect(call.messages).toHaveLength(2);
  });

  it("leaves the request untouched when no inline system message is present", async () => {
    const generateTextSpy = vi.mocked(tracedGenerateText);
    generateTextSpy.mockClear();
    generateTextSpy.mockResolvedValueOnce(fakeGenerateTextResult as any);

    const adapter = createProvider("test-provider", (_modelId) => ({}) as any);
    await adapter.chat({ ...baseRequest, system: "A" }, "gpt-4o");

    const call = generateTextSpy.mock.calls[0][0];
    expect(call.system).toBe("A");
    expect(call.messages).toHaveLength(1);
  });

  it("also folds on the streaming path", async () => {
    const streamTextSpy = vi.mocked(tracedStreamText);
    streamTextSpy.mockClear();
    streamTextSpy.mockResolvedValueOnce(fakeStreamTextResult as any);

    const adapter = createProvider("test-provider", (_modelId) => ({}) as any);
    await adapter.chatStream!(
      {
        ...baseRequest,
        messages: [
          { role: "system", content: "ctx" },
          { role: "user", content: "hi" },
        ],
      },
      "gpt-4o",
    );

    const call = streamTextSpy.mock.calls[0][0];
    expect(call.system).toBe("ctx");
    expect((call.messages as any[]).every((m) => m.role !== "system")).toBe(true);
  });
});

describe("createProvider – cache token usage", () => {
  it("extracts the normalized inputTokenDetails cache breakdown into usage", async () => {
    const generateTextSpy = vi.mocked(tracedGenerateText);
    generateTextSpy.mockClear();
    generateTextSpy.mockResolvedValueOnce({
      text: "hello",
      steps: [],
      reasoning: undefined,
      totalUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        inputTokenDetails: { noCacheTokens: 150, cacheReadTokens: 800, cacheWriteTokens: 50 },
      },
    } as any);

    const adapter = createProvider("anthropic", (_modelId) => ({}) as any);
    const res = await adapter.chat({ ...baseRequest }, "claude-sonnet-4-6");

    expect(res.usage.promptTokens).toBe(1000);
    expect(res.usage.completionTokens).toBe(200);
    expect(res.usage.cachedInputTokens).toBe(800);
    expect(res.usage.cacheCreationInputTokens).toBe(50);
  });

  it("falls back to the deprecated top-level cachedInputTokens for cache reads", async () => {
    const generateTextSpy = vi.mocked(tracedGenerateText);
    generateTextSpy.mockClear();
    generateTextSpy.mockResolvedValueOnce({
      text: "hi",
      steps: [],
      reasoning: undefined,
      totalUsage: { inputTokens: 500, outputTokens: 100, cachedInputTokens: 300 },
    } as any);

    const adapter = createProvider("openai", (_modelId) => ({}) as any);
    const res = await adapter.chat({ ...baseRequest }, "gpt-4o");

    expect(res.usage.cachedInputTokens).toBe(300);
    expect(res.usage.cacheCreationInputTokens).toBe(0);
  });

  it("defaults cache counts to 0 when the provider reports none", async () => {
    const generateTextSpy = vi.mocked(tracedGenerateText);
    generateTextSpy.mockClear();
    generateTextSpy.mockResolvedValueOnce(fakeGenerateTextResult as any);

    const adapter = createProvider("openai", (_modelId) => ({}) as any);
    const res = await adapter.chat({ ...baseRequest }, "gpt-4o");

    expect(res.usage.cachedInputTokens).toBe(0);
    expect(res.usage.cacheCreationInputTokens).toBe(0);
  });
});

describe("aggregateReasoning", () => {
  it("returns undefined when no step has reasoning", () => {
    expect(aggregateReasoning([])).toBeUndefined();
    expect(
      aggregateReasoning([
        {
          index: 0,
          stepType: "initial",
          text: "x",
          toolCalls: [],
          finishReason: "stop",
          durationMs: 1,
        },
      ]),
    ).toBeUndefined();
  });

  it("concatenates per-step reasoning preserving order", () => {
    expect(
      aggregateReasoning([
        {
          index: 0,
          stepType: "initial",
          text: "",
          toolCalls: [],
          finishReason: "stop",
          durationMs: 1,
          reasoning: [{ type: "text", text: "a" }],
        },
        {
          index: 1,
          stepType: "continue",
          text: "",
          toolCalls: [],
          finishReason: "stop",
          durationMs: 1,
          reasoning: [{ type: "text", text: "b", signature: "s" }],
        },
      ]),
    ).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b", signature: "s" },
    ]);
  });
});

describe("normalizeStrictConversation", () => {
  it("returns a well-formed user-first alternation unchanged", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    expect(normalizeStrictConversation(msgs)).toEqual(msgs);
  });

  it("merges consecutive same-role messages into one (parts concatenated)", () => {
    const out = normalizeStrictConversation([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(out[1]).toEqual({ role: "assistant", content: "c" });
  });

  it("prepends a [no-op] user turn when the conversation starts with assistant (proactive)", () => {
    const out = normalizeStrictConversation([
      { role: "assistant", content: "greeting" },
      { role: "user", content: "reply" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "[no-op]" },
      { role: "assistant", content: "greeting" },
      { role: "user", content: "reply" },
    ]);
  });

  it("does not mutate the input array or its messages", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: "x" },
      { role: "user", content: "y" },
    ];
    const snapshot = JSON.stringify(input);
    normalizeStrictConversation(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
