// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asAgentSlug } from "../instances/identifiers.js";

/* ── hoisted mocks ─────────────────────────────────────────────── */

const {
  mockSupervise,
  mockResolveInstanceConfig,
  mockConversationStore,
  mockListAndMarkPendingEvents,
  mockMarkEventsCompleted,
  mockAppendDailyLog,
  mockSetRoomConversationId,
  mockDb,
  mockTraceStore,
  mockExtractMemories,
  mockChat,
  mockGenerateTitle,
} = vi.hoisted(() => ({
  mockSupervise: vi.fn(),
  mockResolveInstanceConfig: vi.fn(),
  mockConversationStore: {
    ensureConversation: vi.fn(),
    getRecentMessages: vi.fn(),
    appendMessages: vi.fn(),
    getTitle: vi.fn(),
    updateTitle: vi.fn(),
  },
  mockListAndMarkPendingEvents: vi.fn(),
  mockMarkEventsCompleted: vi.fn(),
  mockAppendDailyLog: vi.fn(),
  mockSetRoomConversationId: vi.fn(),
  mockDb: {
    select: vi.fn(),
  },
  mockTraceStore: {
    record: vi.fn(),
  },
  mockExtractMemories: vi.fn(),
  mockChat: vi.fn(),
  mockGenerateTitle: vi.fn(),
}));

vi.mock("../utils/title-generator.js", () => ({ generateConversationTitle: mockGenerateTitle }));
vi.mock("../agents/supervisor/index.js", () => ({ supervise: mockSupervise }));
vi.mock("../instances/config-resolver.js", () => ({ resolveInstanceConfig: mockResolveInstanceConfig }));
vi.mock("../conversations/index.js", () => ({ conversationStore: mockConversationStore }));
vi.mock("../webhooks/webhook-backlog.store.js", () => ({
  listAndMarkPendingEventsProcessing: mockListAndMarkPendingEvents,
  markEventsCompleted: mockMarkEventsCompleted,
}));
vi.mock("./activity-log.store.js", () => ({ appendDailyLog: mockAppendDailyLog }));
vi.mock("./room.store.js", () => ({
  setRoomConversationId: mockSetRoomConversationId,
}));
vi.mock("../database/client.js", () => ({ db: mockDb }));
vi.mock("../analytics/trace.store.js", () => ({ traceStore: mockTraceStore }));
vi.mock("../memory/extractor.js", () => ({ extractMemories: mockExtractMemories }));
vi.mock("../ai-gateway/index.js", () => ({ chat: mockChat }));
vi.mock("./room-logger.js", () => ({
  roomLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../webhooks/webhooks.schema.js", () => ({
  eventDefinitions: {
    name: "name",
    interpretationPrompt: "interpretation_prompt",
    id: "id",
  },
}));
vi.mock("drizzle-orm", () => ({
  inArray: vi.fn((...args: unknown[]) => ({ type: "inArray", args })),
}));
vi.mock("../config.js", () => ({
  config: {
    datetime: { locale: "en-US", timezone: "UTC" },
  },
}));

/* ── import under test ─────────────────────────────────────────── */

import { executeRoomCycle } from "./room-engine.js";
import type { RoomConfig } from "./room.store.js";
import { asAgentUuid } from "../instances/identifiers.js";

/* ── helpers ────────────────────────────────────────────────────── */

function makeRoom(overrides: Partial<RoomConfig> = {}): RoomConfig {
  return {
    id: "room-1",
    agentId: asAgentUuid("inst-1"),
    enabled: true,
    prompt: "You are a helpful room agent.",
    outboundChannel: "slack",
    outboundTarget: "#general",
    evalIntervalMinutes: 5,
    conversationId: expect.stringMatching(/^room:inst-1:\d+$/),
    ...overrides,
  };
}

const INSTANCE_CONFIG = {
  provider: "openai",
  model: "gpt-4o",
  apiKeys: { openai: "sk-test" },
  secrets: {},
  memoryEnabled: false,
  knowledgeEnabled: false,
};

function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => self);
      }
      return chain[prop];
    },
  });
  return self;
}

/* ── setup ──────────────────────────────────────────────────────── */

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveInstanceConfig.mockResolvedValue(INSTANCE_CONFIG);
  mockConversationStore.getRecentMessages.mockResolvedValue([]);
  mockConversationStore.appendMessages.mockResolvedValue(undefined);
  mockConversationStore.ensureConversation.mockResolvedValue(undefined);
  mockConversationStore.getTitle.mockResolvedValue("Existing Title");
  mockConversationStore.updateTitle.mockResolvedValue(undefined);
  mockListAndMarkPendingEvents.mockResolvedValue([]);
  mockAppendDailyLog.mockResolvedValue(undefined);
  mockSetRoomConversationId.mockResolvedValue(undefined);
  mockExtractMemories.mockResolvedValue(undefined);
  mockChat.mockResolvedValue({ text: "Room Title", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, durationMs: 100 });
  mockSupervise.mockResolvedValue({
    text: "I've processed the events.",
    steps: [],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    durationMs: 500,
    toolBuildingMs: 10,
  });
});

/* ── tests ──────────────────────────────────────────────────────── */

describe("executeRoomCycle", () => {
  describe("conversation management", () => {
    it("should create a new conversation for each cycle with timestamped ID", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: { type: "test" }, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([{ name: "Test Def", interpretationPrompt: "Handle it" }]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockConversationStore.ensureConversation).toHaveBeenCalledWith(
        expect.stringMatching(/^room:inst-1:\d+$/),
        "test-slug",
        expect.objectContaining({ channel: "room", source: "room" }),
      );
    });

    it("should persist conversationId to room after cycle", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockSetRoomConversationId).toHaveBeenCalledWith(
        "inst-1",
        expect.stringMatching(/^room:inst-1:\d+$/),
      );
    });
  });

  describe("early exit conditions", () => {
    it("should return early (no-op) when no pending events and no human message", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockSupervise).not.toHaveBeenCalled();
      expect(mockConversationStore.appendMessages).not.toHaveBeenCalled();
      expect(mockAppendDailyLog).not.toHaveBeenCalled();
    });

    it("should proceed when there are pending events even without human message", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: { action: "test" }, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([{ name: "Test", interpretationPrompt: "Handle it" }]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockSupervise).toHaveBeenCalledTimes(1);
    });

    it("should proceed when there is a human message even without pending events", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"), "Hello, can you help?");

      expect(mockSupervise).toHaveBeenCalledTimes(1);
    });
  });

  describe("synthetic message construction", () => {
    it("should include pending events with IDs and payloads in the message", async () => {
      const events = [
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: { type: "order.created", orderId: 123 }, matchedAt: new Date("2026-03-30"), createdAt: new Date("2026-03-30") },
        { id: "evt-2", eventDefinitionId: "def-1", rawPayload: { type: "order.created", orderId: 456 }, matchedAt: new Date("2026-03-30"), createdAt: new Date("2026-03-30") },
      ];
      mockListAndMarkPendingEvents.mockResolvedValue(events);
      const selChain = createChainMock([{ name: "Order Def", interpretationPrompt: "Process the order" }]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      const message = mockSupervise.mock.calls[0][0].message as string;
      expect(message).toContain("## Pending Events (2)");
      expect(message).toContain("Event ID: evt-1");
      expect(message).toContain("Event ID: evt-2");
      expect(message).toContain('"orderId":123');
      expect(message).toContain('"orderId":456');
    });

    it("should include event handling instructions from definitions", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([
        { name: "Ticket Alert", interpretationPrompt: "Notify the team about the new ticket and ask for assignment." },
      ]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      const message = mockSupervise.mock.calls[0][0].message as string;
      expect(message).toContain("## Event Handling Instructions");
      expect(message).toContain("### Ticket Alert");
      expect(message).toContain("Notify the team about the new ticket");
    });

    it("should include human message section when provided", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"), "Please check the latest tickets");

      const message = mockSupervise.mock.calls[0][0].message as string;
      expect(message).toContain("## Human Message");
      expect(message).toContain("Please check the latest tickets");
    });

    it("should include context usage estimate in the message", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      const message = mockSupervise.mock.calls[0][0].message as string;
      expect(message).toContain("[Room context usage:");
      expect(message).toContain("/ 128,000 tokens");
    });
  });

  describe("conversation persistence", () => {
    it("should append human message to conversation history before calling supervisor", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"), "Human says hello");

      // Synthetic user message should be appended BEFORE supervise call
      const appendCalls = mockConversationStore.appendMessages.mock.calls;
      const firstCall = appendCalls[0];
      expect(firstCall[0]).toMatch(/^room:inst-1:\d+$/);
      expect(firstCall[1][0].role).toBe("user");
      expect(firstCall[1][0].content).toContain("Human says hello");
      // Then supervise should have been called
      expect(mockSupervise).toHaveBeenCalled();
    });

    it("should append assistant response to conversation after supervisor completes", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      // Second call to appendMessages is the assistant response
      const appendCalls = mockConversationStore.appendMessages.mock.calls;
      const lastCall = appendCalls[appendCalls.length - 1];
      expect(lastCall[0]).toMatch(/^room:inst-1:\d+$/);
      expect(lastCall[1][0].role).toBe("assistant");
      expect(lastCall[1][0].content).toBe("I've processed the events.");
    });
  });

  describe("supervisor invocation", () => {
    it("should pass correct instance config to supervisor", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockSupervise).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "test-slug",
          conversationId: expect.stringMatching(/^room:inst-1:\d+$/),
          provider: "openai",
          model: "gpt-4o",
          apiKeys: { openai: "sk-test" },
          memoryEnabled: false,
          includeHarness: new Set(["room"]),
        }),
      );
    });

    it("should pass memoryEnabled from instance config", async () => {
      mockResolveInstanceConfig.mockResolvedValue({ ...INSTANCE_CONFIG, memoryEnabled: true });
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockSupervise).toHaveBeenCalledWith(
        expect.objectContaining({ memoryEnabled: true }),
      );
    });
  });

  describe("debug capture", () => {
    it("threads debugEnabled from instance config into supervise", async () => {
      mockResolveInstanceConfig.mockResolvedValue({ ...INSTANCE_CONFIG, debugEnabled: true });
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockSupervise).toHaveBeenCalledWith(
        expect.objectContaining({ debugEnabled: true }),
      );
    });

    it("persists debugPayload on the assistant message when supervise returns one", async () => {
      const debugPayload = { system: "sys", messages: [], tools: [] };
      mockSupervise.mockResolvedValue({
        text: "I've processed the events.",
        steps: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        durationMs: 500,
        toolBuildingMs: 10,
        debugPayload,
      });
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      const appendCalls = mockConversationStore.appendMessages.mock.calls;
      const assistantCall = appendCalls.find(
        ([, msgs]) => Array.isArray(msgs) && msgs[0]?.role === "assistant",
      );
      expect(assistantCall![1][0].debugPayload).toEqual(debugPayload);
    });

    it("omits debugPayload when supervise returns none (debug off)", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      const appendCalls = mockConversationStore.appendMessages.mock.calls;
      const assistantCall = appendCalls.find(
        ([, msgs]) => Array.isArray(msgs) && msgs[0]?.role === "assistant",
      );
      expect(assistantCall![1][0]).not.toHaveProperty("debugPayload");
    });
  });

  describe("activity logging", () => {
    it("should log event count and response preview to daily activity", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
        { id: "evt-2", eventDefinitionId: "def-2", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockAppendDailyLog).toHaveBeenCalledWith(
        "inst-1",
        expect.stringContaining("2 event(s)"),
        2,
      );
    });

    it("should mention human message in activity log when present", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"), "Help me");

      expect(mockAppendDailyLog).toHaveBeenCalledWith(
        "inst-1",
        expect.stringContaining("I've processed the events."),
        0,
      );
    });
  });

  describe("pipeline tracing", () => {
    it("should record pipeline trace with channel room after cycle", async () => {
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      expect(mockTraceStore.record).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: expect.stringMatching(/^room:inst-1:\d+$/),
          agentId: "test-slug",
          channel: "room",
          isStreaming: false,
          llmCallMs: 500,
        }),
      );
    });
  });

  describe("post-processing", () => {
    it("should call extractMemories when memoryEnabled is true", async () => {
      mockResolveInstanceConfig.mockResolvedValue({ ...INSTANCE_CONFIG, memoryEnabled: true });
      mockConversationStore.getTitle.mockResolvedValue("Existing Title");
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      // Give fire-and-forget a tick to run
      await new Promise((r) => setTimeout(r, 10));

      expect(mockExtractMemories).toHaveBeenCalledWith(
        expect.stringMatching(/^room:inst-1:\d+$/),
        "test-slug",
        { openai: "sk-test" },
        "openai",
      );
    });

    it("should NOT call extractMemories when memoryEnabled is false", async () => {
      mockResolveInstanceConfig.mockResolvedValue({ ...INSTANCE_CONFIG, memoryEnabled: false });
      mockConversationStore.getTitle.mockResolvedValue("Existing Title");
      mockListAndMarkPendingEvents.mockResolvedValue([
        { id: "evt-1", eventDefinitionId: "def-1", rawPayload: {}, matchedAt: new Date(), createdAt: new Date() },
      ]);
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await executeRoomCycle(makeRoom(), asAgentSlug("test-slug"));

      // Give fire-and-forget a tick to run
      await new Promise((r) => setTimeout(r, 10));

      expect(mockExtractMemories).not.toHaveBeenCalled();
    });
  });
});
