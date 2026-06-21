// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("langsmith", () => {
  const MockClient = vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  });
  return { Client: MockClient };
});

vi.mock("langsmith/experimental/vercel", () => ({
  wrapAISDK: vi.fn().mockReturnValue({
    generateText: vi.fn(),
    streamText: vi.fn(),
  }),
  createLangSmithProviderOptions: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
    ...config,
    _wrapped: true,
  })),
  convertMessageToTracedFormat: vi.fn().mockImplementation((msg: unknown) => msg),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  generateObject: vi.fn(),
  streamObject: vi.fn(),
  wrapLanguageModel: vi.fn(),
}));

import { buildLangSmithProviderOptions, getClient } from "./langsmith.js";
import { createLangSmithProviderOptions } from "langsmith/experimental/vercel";
import { Client } from "langsmith";

describe("langsmith", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getClient", () => {
    it("creates a new Client for a given API key", () => {
      const client = getClient("ls-key-1");

      expect(Client).toHaveBeenCalledWith({ apiKey: "ls-key-1" });
      expect(client).toBeDefined();
    });

    it("returns the same cached Client for the same API key", () => {
      const client1 = getClient("ls-key-cached");
      const client2 = getClient("ls-key-cached");

      expect(client1).toBe(client2);
      expect(Client).toHaveBeenCalledTimes(1);
    });

    it("creates different Clients for different API keys", () => {
      const client1 = getClient("ls-key-a");
      const client2 = getClient("ls-key-b");

      expect(client1).not.toBe(client2);
    });
  });

  describe("buildLangSmithProviderOptions", () => {
    it("omits ls_provider and ls_model_name from metadata to prevent auto-pricing conflicts", () => {
      buildLangSmithProviderOptions(
        { apiKey: "ls-key", project: "my-project" },
        { conversationId: "conv-123", agentId: "inst-456", providerName: "openai", modelId: "gpt-4o-mini" },
      );

      const call = (createLangSmithProviderOptions as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.metadata).toEqual({
        oa_conversation_id: "conv-123",
        thread_id: "conv-123",
        agent_id: "inst-456",
      });
      // ls_provider and ls_model_name must NOT be present — our processOutputs
      // sends explicit costs; auto-pricing would conflict with our config.ts
      expect(call.metadata).not.toHaveProperty("ls_provider");
      expect(call.metadata).not.toHaveProperty("ls_model_name");
    });

    it("appends -service suffix to thread_id for service call type", () => {
      buildLangSmithProviderOptions(
        { apiKey: "ls-key", project: "proj" },
        { conversationId: "conv-123", agentId: "inst-456", callType: "service" },
      );

      const call = (createLangSmithProviderOptions as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.metadata).toEqual({
        oa_conversation_id: "conv-123",
        thread_id: "conv-123-service",
        agent_id: "inst-456",
      });
    });

    it("uses conversationId as thread_id for conversation call type", () => {
      buildLangSmithProviderOptions(
        { apiKey: "ls-key", project: "proj" },
        { conversationId: "conv-123", callType: "conversation" },
      );

      const call = (createLangSmithProviderOptions as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.metadata.thread_id).toBe("conv-123");
    });

    it("includes only conversation and instance metadata when provider context is partial", () => {
      buildLangSmithProviderOptions(
        { apiKey: "ls-key", project: "proj" },
        { conversationId: "conv-1" },
      );

      expect(createLangSmithProviderOptions).toHaveBeenCalledWith({
        client: expect.anything(),
        project_name: "proj",
        tracingEnabled: true,
        metadata: {
          oa_conversation_id: "conv-1",
          thread_id: "conv-1",
        },
        processOutputs: expect.any(Function),
      });
    });

    it("passes empty metadata when no context is provided", () => {
      buildLangSmithProviderOptions({ apiKey: "ls-key", project: "proj" });

      expect(createLangSmithProviderOptions).toHaveBeenCalledWith({
        client: expect.anything(),
        project_name: "proj",
        tracingEnabled: true,
        metadata: {},
        processOutputs: expect.any(Function),
      });
    });

    it("reuses cached client for same API key across calls", () => {
      buildLangSmithProviderOptions({ apiKey: "ls-same-key", project: "p1" });
      buildLangSmithProviderOptions({ apiKey: "ls-same-key", project: "p2" });

      const calls = (Client as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => (c[0] as { apiKey: string }).apiKey === "ls-same-key");
      expect(calls).toHaveLength(1);
    });
  });

  describe("processOutputs (display-only, no token/cost reporting)", () => {
    function getProcessOutputs(context?: Parameters<typeof buildLangSmithProviderOptions>[1]) {
      buildLangSmithProviderOptions(
        { apiKey: "ls-key", project: "proj" },
        context,
      );
      const call = (createLangSmithProviderOptions as ReturnType<typeof vi.fn>).mock.calls[0][0];
      return call.processOutputs as (outputs: unknown) => Promise<unknown>;
    }

    it("formats generateText output for LangSmith display", async () => {
      const processOutputs = getProcessOutputs();

      const result = await processOutputs({
        outputs: {
          text: "Hello world",
          steps: [{ content: "Hello world" }],
          usage: { promptTokens: 100, completionTokens: 50 },
        },
      }) as Record<string, unknown>;

      // Should format content but NOT include usage_metadata (child runs handle that)
      expect(result).toEqual({ content: "Hello world", role: "assistant" });
      expect(result).not.toHaveProperty("usage_metadata");
    });

    it("formats streaming output where content is a Promise", async () => {
      const processOutputs = getProcessOutputs();

      const result = await processOutputs({
        outputs: {
          content: Promise.resolve("Streamed response"),
          text: Promise.resolve("Streamed response"),
          usage: Promise.resolve({ promptTokens: 200, completionTokens: 100 }),
        },
      }) as Record<string, unknown>;

      expect(result).toEqual({ content: "Streamed response", role: "assistant" });
      expect(result).not.toHaveProperty("usage_metadata");
    });

    it("returns outputs unchanged when content is missing", async () => {
      const processOutputs = getProcessOutputs();

      const input = { outputs: { noContent: true } };
      const result = await processOutputs(input);
      expect(result).toEqual(input);
    });

    it("does not throw on malformed outputs", async () => {
      const processOutputs = getProcessOutputs();

      const result = await processOutputs(null);
      expect(result).toBeNull();
    });
  });
});
