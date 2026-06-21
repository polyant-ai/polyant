// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProviderChat = vi.fn();
const mockProviderChatStream = vi.fn();

vi.mock("./providers/openai.js", () => ({
  OpenAIProvider: {
    name: "openai",
    chat: (...args: unknown[]) => mockProviderChat(...args),
    chatStream: (...args: unknown[]) => mockProviderChatStream(...args),
  },
}));

vi.mock("./providers/anthropic.js", () => ({
  AnthropicProvider: {
    name: "anthropic",
    chat: vi.fn(),
    chatStream: vi.fn(),
  },
}));

vi.mock("./logger.js", () => ({
  aiLogger: {
    log: vi.fn(),
    createEntry: vi.fn().mockReturnValue({ provider: "openai", model: "gpt-4o" }),
    initialize: vi.fn(),
    shutdown: vi.fn(),
  },
}));

vi.mock("./langsmith.js", () => ({
  buildLangSmithProviderOptions: vi.fn().mockReturnValue({ traced: true }),
  tracedGenerateText: vi.fn(),
  tracedStreamText: vi.fn(),
}));

vi.mock("../utils/pipeline-logger.js", () => ({
  pipelineLog: {
    llmCall: vi.fn(),
    llmResponse: vi.fn(),
    toolCall: vi.fn(),
  },
}));

const mockEmitFromChatResponse = vi.fn();
const mockTapAndForwardFullStream = vi.fn(async function* (
  fullStream: AsyncIterable<unknown>,
  _ctx: unknown,
) {
  for await (const c of fullStream) yield c;
});
vi.mock("../activity-stream/bus-emitter.js", () => ({
  emitFromChatResponse: (...args: unknown[]) => mockEmitFromChatResponse(...args),
  tapAndForwardFullStream: (s: AsyncIterable<unknown>, ctx: unknown) =>
    mockTapAndForwardFullStream(s, ctx),
}));

vi.mock("../instances/store.js", () => ({
  findInstanceBySlug: vi.fn().mockResolvedValue(null),
}));

import { chat, chatStream, initAIGateway } from "./index.js";
import { aiLogger } from "./logger.js";
import { buildLangSmithProviderOptions } from "./langsmith.js";
import { findInstanceBySlug } from "../instances/store.js";
import type { ChatRequest } from "./types.js";
import { asAgentSlug } from "../instances/identifiers.js";

const mockFindInstanceBySlug = vi.mocked(findInstanceBySlug);

/** Flush the microtask queue so fire-and-forget bus emission settles. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    tier: "standard",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

function makeChatResponse(overrides = {}) {
  return {
    text: "Response text",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    durationMs: 500,
    model: "gpt-4o",
    provider: "openai",
    steps: [],
    toolCalls: [],
    ...overrides,
  };
}

describe("AI Gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("chat", () => {
    it("resolves model from tier and delegates to provider", async () => {
      const mockResponse = makeChatResponse();
      mockProviderChat.mockResolvedValue(mockResponse);

      const result = await chat(makeRequest({ tier: "standard" }));

      expect(mockProviderChat).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "standard" }),
        "gpt-4o",
      );
      expect(result.text).toBe("Response text");
    });

    it("resolves fast tier to gpt-4o-mini", async () => {
      mockProviderChat.mockResolvedValue(makeChatResponse({ model: "gpt-4o-mini" }));

      await chat(makeRequest({ tier: "fast" }));

      expect(mockProviderChat).toHaveBeenCalledWith(
        expect.anything(),
        "gpt-4o-mini",
      );
    });

    it("logs cost via aiLogger", async () => {
      mockProviderChat.mockResolvedValue(makeChatResponse());

      await chat(makeRequest());

      expect(aiLogger.createEntry).toHaveBeenCalled();
      expect(aiLogger.log).toHaveBeenCalled();
    });

    it("passes conversationId, agentId, and callType to logger", async () => {
      mockProviderChat.mockResolvedValue(makeChatResponse());

      await chat(makeRequest(), { conversationId: "conv-1", agentId: asAgentSlug("user-1") });

      expect(aiLogger.createEntry).toHaveBeenCalledWith(
        "openai", "gpt-4o", "standard", false,
        100, 50, 150,
        expect.any(Number),
        500,
        expect.any(Number),
        expect.any(Number),
        "conv-1", "user-1",
        undefined, // callType defaults to undefined when not specified
      );
    });

    it("passes callType 'service' to logger when specified", async () => {
      mockProviderChat.mockResolvedValue(makeChatResponse());

      await chat(makeRequest(), { conversationId: "conv-1", agentId: asAgentSlug("inst-1"), callType: "service" });

      expect(aiLogger.createEntry).toHaveBeenCalledWith(
        "openai", "gpt-4o", "standard", false,
        100, 50, 150,
        expect.any(Number),
        500,
        expect.any(Number),
        expect.any(Number),
        "conv-1", "inst-1",
        "service",
      );
    });

    it("returns full response from provider", async () => {
      const response = makeChatResponse({
        steps: [
          {
            index: 0,
            stepType: "initial",
            text: "",
            toolCalls: [{ toolCallId: "tc-1", toolName: "search", args: {} }],
            finishReason: "tool-calls",
            durationMs: 100,
          },
        ],
      });
      mockProviderChat.mockResolvedValue(response);

      const result = await chat(makeRequest());
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].toolCalls[0].toolName).toBe("search");
      expect(result.usage.totalTokens).toBe(150);
    });

    it("emits the instance icon to the activity bus as a URL, never the raw base64 data URI", async () => {
      // Regression: buildBusContext used to pass `instance.icon` (a
      // `data:image/...;base64,...` URI) straight through, so the activity
      // feed rendered the base64 string as text. It MUST be a /api URL — the
      // same conversion the per-category emitters and the REST DTO apply.
      mockFindInstanceBySlug.mockResolvedValueOnce({
        id: "uuid-1",
        slug: "acme",
        name: "Acme",
        icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE",
        updatedAt: new Date(1700000000000),
      } as unknown as Awaited<ReturnType<typeof findInstanceBySlug>>);
      mockProviderChat.mockResolvedValue(makeChatResponse());

      await chat(makeRequest(), { conversationId: "conv-1", agentId: asAgentSlug("acme") });
      await flushMicrotasks();

      expect(mockEmitFromChatResponse).toHaveBeenCalled();
      const ctx = mockEmitFromChatResponse.mock.calls[0][1] as { instance?: { icon?: string | null } };
      expect(ctx.instance?.icon).toBe("/api/instances/acme/icon?v=1700000000000");
      expect(ctx.instance?.icon).not.toContain("base64");
    });

    it("passes langsmith providerOptions to provider when langsmith config is present", async () => {
      mockProviderChat.mockResolvedValue(makeChatResponse());

      await chat(
        makeRequest({ langsmith: { apiKey: "ls-key", project: "test-project" } }),
        { conversationId: "conv-1", agentId: asAgentSlug("inst-1") },
      );

      expect(buildLangSmithProviderOptions).toHaveBeenCalledWith(
        { apiKey: "ls-key", project: "test-project" },
        { conversationId: "conv-1", agentId: asAgentSlug("inst-1"), providerName: "openai", modelId: "gpt-4o" },
      );
      expect(mockProviderChat).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: expect.objectContaining({
            langsmith: expect.any(Object),
          }),
        }),
        expect.any(String),
      );
    });

    it("does not build langsmith providerOptions when langsmith config is absent (still sets openai strictJsonSchema)", async () => {
      mockProviderChat.mockResolvedValue(makeChatResponse());

      await chat(makeRequest());

      expect(buildLangSmithProviderOptions).not.toHaveBeenCalled();
      // v6: openai always gets strictJsonSchema:false (replaces the removed
      // factory option structuredOutputs:false). No langsmith key is added.
      expect(mockProviderChat).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: { openai: { strictJsonSchema: false } },
        }),
        expect.any(String),
      );
    });
  });

  describe("chatStream", () => {
    it("returns textStream and response promise", async () => {
      const mockTextStream = (async function* () { yield "chunk"; })();
      const mockResponse = Promise.resolve(makeChatResponse());
      mockProviderChatStream.mockReturnValue({
        textStream: mockTextStream,
        response: mockResponse,
      });

      const stream = await chatStream(makeRequest());
      expect(stream.textStream).toBeDefined();
      expect(stream.response).toBeDefined();
    });

    it("logs cost when response promise resolves", async () => {
      const mockTextStream = (async function* () { yield "chunk"; })();
      mockProviderChatStream.mockReturnValue({
        textStream: mockTextStream,
        response: Promise.resolve(makeChatResponse()),
      });

      const stream = await chatStream(makeRequest());
      await stream.response;

      expect(aiLogger.log).toHaveBeenCalled();
    });

    it("passes callType through to logger in streaming mode", async () => {
      const mockTextStream = (async function* () { yield "chunk"; })();
      mockProviderChatStream.mockReturnValue({
        textStream: mockTextStream,
        response: Promise.resolve(makeChatResponse()),
      });

      const stream = await chatStream(makeRequest(), { conversationId: "conv-1", agentId: asAgentSlug("inst-1"), callType: "service" });
      await stream.response;

      expect(aiLogger.createEntry).toHaveBeenCalledWith(
        "openai", "gpt-4o", "standard", false,
        100, 50, 150,
        expect.any(Number),
        500,
        expect.any(Number),
        expect.any(Number),
        "conv-1", "inst-1",
        "service",
      );
    });

    it("passes langsmith providerOptions in streaming mode", async () => {
      const mockTextStream = (async function* () { yield "chunk"; })();
      mockProviderChatStream.mockReturnValue({
        textStream: mockTextStream,
        response: Promise.resolve(makeChatResponse()),
      });

      await chatStream(
        makeRequest({ langsmith: { apiKey: "ls-key", project: "test-project" } }),
        { conversationId: "conv-1", agentId: asAgentSlug("inst-1") },
      );

      expect(buildLangSmithProviderOptions).toHaveBeenCalledWith(
        { apiKey: "ls-key", project: "test-project" },
        { conversationId: "conv-1", agentId: asAgentSlug("inst-1"), providerName: "openai", modelId: "gpt-4o" },
      );
      expect(mockProviderChatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: expect.objectContaining({
            langsmith: expect.any(Object),
          }),
        }),
        expect.any(String),
      );
    });
  });

  describe("initAIGateway", () => {
    it("initializes logger", () => {
      // Reset the module-level `initialized` flag by re-importing
      // For this test we just verify the function is callable without error
      // (it's idempotent — may already be initialized from prior tests)
      expect(() => initAIGateway()).not.toThrow();
    });
  });
});
