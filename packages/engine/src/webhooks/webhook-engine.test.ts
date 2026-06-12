// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

/* ── hoisted mocks ─────────────────────────────────────────────── */

const {
  mockSupervise,
  mockEnsureConversation,
  mockAppendMessages,
  mockClearContextPrompt,
  mockResolveInstanceConfig,
  mockExtractMemories,
  mockGenerateConversationTitle,
  mockSendOutbound,
  mockRegisterTrigger,
  mockSetTriggerContext,
  mockClearTriggerContext,
  mockTraceRecord,
  mockWebhookLog,
} = vi.hoisted(() => ({
  mockSupervise: vi.fn(),
  mockEnsureConversation: vi.fn(),
  mockAppendMessages: vi.fn(),
  mockClearContextPrompt: vi.fn(),
  mockResolveInstanceConfig: vi.fn(),
  mockExtractMemories: vi.fn(),
  mockGenerateConversationTitle: vi.fn(),
  mockSendOutbound: vi.fn(),
  mockRegisterTrigger: vi.fn(),
  mockSetTriggerContext: vi.fn(),
  mockClearTriggerContext: vi.fn(),
  mockTraceRecord: vi.fn(),
  mockWebhookLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../agents/supervisor/index.js", () => ({ supervise: mockSupervise }));
vi.mock("../conversations/index.js", () => ({
  conversationStore: {
    ensureConversation: mockEnsureConversation,
    appendMessages: mockAppendMessages,
    clearContextPrompt: mockClearContextPrompt,
  },
}));
vi.mock("../instances/config-resolver.js", () => ({
  resolveInstanceConfig: mockResolveInstanceConfig,
}));
vi.mock("../memory/extractor.js", () => ({ extractMemories: mockExtractMemories }));
vi.mock("../utils/title-generator.js", () => ({ generateConversationTitle: mockGenerateConversationTitle }));
vi.mock("../channels/channel-manager.js", () => ({
  channelManager: { sendOutbound: mockSendOutbound },
}));
vi.mock("./active-triggers.js", () => ({ registerTrigger: mockRegisterTrigger }));
vi.mock("./trigger-context.js", () => ({
  setTriggerContext: mockSetTriggerContext,
  clearTriggerContext: mockClearTriggerContext,
}));
vi.mock("./webhook-logger.js", () => ({ webhookLog: mockWebhookLog }));
vi.mock("../analytics/trace.store.js", () => ({
  traceStore: { record: mockTraceRecord },
}));
// Activity-stream emit is fire-and-forget; stub it so the test never touches
// the real bus or instance-meta lookup.
vi.mock("../activity-stream/emitters/emit-conversation.js", () => ({ emitConversation: vi.fn() }));
vi.mock("../activity-stream/emit-helpers.js", () => ({ resolveInstanceMeta: vi.fn(async () => ({})) }));

// Conversation state buffer: a shared mock instance so we can assert seedChannel/flush.
const { mockStateBufferLoad, mockSeedChannel, mockFlush, mockStateBuffer } = vi.hoisted(() => {
  const seedChannel = vi.fn();
  const flush = vi.fn(async () => {});
  const buffer = {
    seedChannel,
    flush,
    api: () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => ({}), channel: undefined }),
  };
  return {
    mockStateBufferLoad: vi.fn(async () => buffer),
    mockSeedChannel: seedChannel,
    mockFlush: flush,
    mockStateBuffer: buffer,
  };
});
vi.mock("../conversations/state.buffer.js", () => ({
  ConversationStateBuffer: Object.assign(
    function () { return mockStateBuffer; },
    { load: mockStateBufferLoad },
  ),
}));

/* ── import under test ─────────────────────────────────────────── */

import { triggerConversation } from "./webhook-engine.js";
import type { EventDefinition } from "./webhook-sources.store.js";

/* ── fixtures ──────────────────────────────────────────────────── */

const baseDefinition: EventDefinition = {
  id: "def-1",
  eventSourceId: "src-1",
  name: "Test Definition",
  matchingPrompt: "match anything",
  interpretationPrompt: "",
  action: "conversation",
  contextPrompt: "Handle event with payload {{payload}}",
  outboundChannel: null,
  outboundTarget: null,
  enabled: true,
};

const baseSuperviseResult = {
  text: "Done.",
  steps: [],
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  durationMs: 100,
  toolBuildingMs: 5,
  toolCallTraces: undefined,
  ttfbMs: undefined,
  replyHandled: false,
  replyText: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveInstanceConfig.mockResolvedValue({
    provider: "openai",
    model: "gpt-4o",
    apiKeys: { openai: "sk-test" },
    secrets: {},
    memoryEnabled: false,
    knowledgeEnabled: false,
  });
  mockEnsureConversation.mockResolvedValue({ created: true });
  mockAppendMessages.mockResolvedValue(undefined);
  mockClearContextPrompt.mockResolvedValue(undefined);
  mockSupervise.mockResolvedValue(baseSuperviseResult);
  mockGenerateConversationTitle.mockResolvedValue(undefined);
});

/* ── tests ──────────────────────────────────────────────────────── */

describe("triggerConversation", () => {
  describe("guard: missing contextPrompt", () => {
    it("returns early when contextPrompt is missing", async () => {
      const def: EventDefinition = { ...baseDefinition, contextPrompt: null };

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), def, { foo: "bar" });

      expect(mockEnsureConversation).not.toHaveBeenCalled();
      expect(mockSupervise).not.toHaveBeenCalled();
      expect(mockWebhookLog.warn).toHaveBeenCalledWith(
        "TriggerEngine",
        expect.stringContaining("missing contextPrompt"),
      );
    });
  });

  describe("channel mode (outboundChannel + outboundTarget)", () => {
    const channelDef: EventDefinition = {
      ...baseDefinition,
      outboundChannel: "telegram",
      outboundTarget: "{{payload.chat_id}}",
    };

    it("builds channel-keyed conversationId and registers trigger", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "12345" });

      const expectedId = "test-slug:telegram:12345";
      expect(mockEnsureConversation).toHaveBeenCalledWith(
        expectedId,
        "test-slug",
        expect.objectContaining({ channel: "telegram", source: "webhook" }),
      );
      expect(mockRegisterTrigger).toHaveBeenCalledWith("test-slug", "telegram", "12345", expectedId);
      expect(mockSetTriggerContext).toHaveBeenCalledWith(
        expectedId,
        expect.objectContaining({ outboundChannel: "telegram", outboundTarget: "12345" }),
      );
    });

    it("invokes channelManager.sendOutbound with rendered target", async () => {
      mockSupervise.mockResolvedValue({ ...baseSuperviseResult, text: "Hello user" });

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "9999" });

      expect(mockSendOutbound).toHaveBeenCalledWith("test-slug", "telegram", "9999", "Hello user");
    });

    it("skips channelManager.sendOutbound when replyHandled", async () => {
      mockSupervise.mockResolvedValue({
        ...baseSuperviseResult,
        text: "meta",
        replyHandled: true,
        replyText: "actual reply",
      });

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "9999" });

      expect(mockSendOutbound).not.toHaveBeenCalled();
      // assistant message persisted with replyText, not text
      expect(mockAppendMessages).toHaveBeenCalledWith(
        "test-slug:telegram:9999",
        [expect.objectContaining({ role: "assistant", content: "actual reply" })],
      );
    });

    it("clears trigger context after successful run", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "1" });
      expect(mockClearTriggerContext).toHaveBeenCalledWith("test-slug:telegram:1");
    });

    it("returns early when outboundTarget renders to empty", async () => {
      const def: EventDefinition = {
        ...channelDef,
        outboundTarget: "{{payload.missing}}",
      };

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), def, { chat_id: "1" });

      expect(mockEnsureConversation).not.toHaveBeenCalled();
      expect(mockSupervise).not.toHaveBeenCalled();
      expect(mockWebhookLog.warn).toHaveBeenCalledWith(
        "TriggerEngine",
        expect.stringContaining("outboundTarget resolved to empty"),
      );
    });

    it("records trace with the channel name", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "x" });
      expect(mockTraceRecord).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "telegram" }),
      );
    });
  });

  describe("internal mode (no outboundChannel)", () => {
    it("builds fresh per-event conversationId with definition id and timestamp", async () => {
      const before = Date.now();
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });
      const after = Date.now();

      const calls = mockEnsureConversation.mock.calls;
      expect(calls).toHaveLength(1);
      const [conversationId, slug, opts] = calls[0];
      expect(slug).toBe("test-slug");
      expect(opts).toMatchObject({ channel: "webhook", source: "webhook" });

      const match = (conversationId as string).match(/^test-slug:webhook:def-1:(\d+)$/);
      expect(match).not.toBeNull();
      const ts = Number(match![1]);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("does NOT register active trigger or set trigger context", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      expect(mockRegisterTrigger).not.toHaveBeenCalled();
      expect(mockSetTriggerContext).not.toHaveBeenCalled();
      expect(mockClearTriggerContext).not.toHaveBeenCalled();
    });

    it("does NOT call channelManager.sendOutbound", async () => {
      mockSupervise.mockResolvedValue({ ...baseSuperviseResult, text: "Internal action complete" });

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      expect(mockSendOutbound).not.toHaveBeenCalled();
    });

    it("still persists assistant response to conversation", async () => {
      mockSupervise.mockResolvedValue({ ...baseSuperviseResult, text: "Internal action complete" });

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      const assistantCall = mockAppendMessages.mock.calls.find(
        ([, msgs]) => Array.isArray(msgs) && msgs[0]?.role === "assistant",
      );
      expect(assistantCall).toBeDefined();
      expect(assistantCall![1][0].content).toBe("Internal action complete");
    });

    it("calls supervise with empty harness categories and undefined channelIdentity", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      const superviseArg = mockSupervise.mock.calls[0][0];
      expect(superviseArg.channelIdentity).toBeUndefined();
      expect(superviseArg.includeHarness).toBeInstanceOf(Set);
      expect((superviseArg.includeHarness as Set<string>).size).toBe(0);
    });

    it("records trace with channel='webhook'", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });
      expect(mockTraceRecord).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "webhook" }),
      );
    });

    it("creates a new conversationId on each call (one-shot semantics)", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: 1 });
      // Force a different timestamp
      await new Promise((r) => setTimeout(r, 5));
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: 2 });

      const ids = mockEnsureConversation.mock.calls.map((c) => c[0]);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[0]).toMatch(/^test-slug:webhook:def-1:\d+$/);
      expect(ids[1]).toMatch(/^test-slug:webhook:def-1:\d+$/);
    });
  });

  describe("debug capture", () => {
    it("threads debugEnabled from instance config into supervise", async () => {
      mockResolveInstanceConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-4o",
        apiKeys: { openai: "sk-test" },
        secrets: {},
        memoryEnabled: false,
        knowledgeEnabled: false,
        debugEnabled: true,
      });

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      expect(mockSupervise.mock.calls[0][0].debugEnabled).toBe(true);
    });

    it("persists debugPayload on the assistant message when supervise returns one", async () => {
      const debugPayload = { system: "sys", messages: [], tools: [] };
      mockSupervise.mockResolvedValue({ ...baseSuperviseResult, debugPayload });

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      const assistantCall = mockAppendMessages.mock.calls.find(
        ([, msgs]) => Array.isArray(msgs) && msgs[0]?.role === "assistant",
      );
      expect(assistantCall![1][0].debugPayload).toEqual(debugPayload);
    });

    it("omits debugPayload when supervise returns none (debug off)", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      const assistantCall = mockAppendMessages.mock.calls.find(
        ([, msgs]) => Array.isArray(msgs) && msgs[0]?.role === "assistant",
      );
      expect(assistantCall![1][0]).not.toHaveProperty("debugPayload");
    });
  });

  describe("supervise failure", () => {
    it("returns early without sending when supervise throws (channel mode)", async () => {
      mockSupervise.mockRejectedValue(new Error("LLM exploded"));
      const def: EventDefinition = {
        ...baseDefinition,
        outboundChannel: "slack",
        outboundTarget: "C123",
      };

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), def, { foo: "bar" });

      expect(mockSendOutbound).not.toHaveBeenCalled();
      expect(mockClearTriggerContext).toHaveBeenCalled();
      expect(mockWebhookLog.error).toHaveBeenCalled();
    });

    it("returns early when supervise throws (internal mode)", async () => {
      mockSupervise.mockRejectedValue(new Error("LLM exploded"));

      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });

      expect(mockSendOutbound).not.toHaveBeenCalled();
      expect(mockClearTriggerContext).not.toHaveBeenCalled();
      expect(mockWebhookLog.error).toHaveBeenCalled();
    });
  });

  describe("conversation state (commit-on-success)", () => {
    const channelDef: EventDefinition = {
      ...baseDefinition,
      outboundChannel: "telegram",
      outboundTarget: "{{payload.chat_id}}",
    };

    it("loads a state buffer for the conversation and passes it to supervise", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "42" });
      expect(mockStateBufferLoad).toHaveBeenCalledWith("test-slug:telegram:42", "test-slug");
      expect(mockSupervise.mock.calls[0][0].stateBuffer).toBe(mockStateBuffer);
    });

    it("seeds the trusted channel identity in channel mode", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "42" });
      expect(mockSeedChannel).toHaveBeenCalledWith({ type: "telegram", id: "42" });
    });

    it("flushes the state buffer after supervise succeeds", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "42" });
      expect(mockFlush).toHaveBeenCalledTimes(1);
    });

    it("does NOT flush when supervise throws (no commit on failure)", async () => {
      mockSupervise.mockRejectedValue(new Error("boom"));
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), channelDef, { chat_id: "42" });
      expect(mockFlush).not.toHaveBeenCalled();
    });

    it("internal mode: loads buffer but does NOT seed a channel", async () => {
      await triggerConversation("inst-1", asInstanceSlug("test-slug"), baseDefinition, { foo: "bar" });
      expect(mockStateBufferLoad).toHaveBeenCalled();
      expect(mockSeedChannel).not.toHaveBeenCalled();
    });
  });
});
