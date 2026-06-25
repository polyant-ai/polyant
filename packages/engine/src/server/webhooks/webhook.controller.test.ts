// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── hoisted mocks ─────────────────────────────────────────────── */

const {
  mockFindByWebhookToken,
  mockListEnabledDefinitions,
  mockGetRoomByInstanceId,
  mockMatchEvent,
  mockInsertEvent,
  mockTriggerConversation,
  mockResolveAgentSlug,
  mockWebhookLog,
} = vi.hoisted(() => ({
  mockFindByWebhookToken: vi.fn(),
  mockListEnabledDefinitions: vi.fn(),
  mockGetRoomByInstanceId: vi.fn(),
  mockMatchEvent: vi.fn(),
  mockInsertEvent: vi.fn(),
  mockTriggerConversation: vi.fn(),
  mockResolveAgentSlug: vi.fn(),
  mockWebhookLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../webhooks/webhook-sources.store.js", () => ({
  findByWebhookToken: mockFindByWebhookToken,
  listEnabledDefinitions: mockListEnabledDefinitions,
}));
vi.mock("../../room/room.store.js", () => ({ getRoomByInstanceId: mockGetRoomByInstanceId }));
vi.mock("../../webhooks/webhook-matcher.js", () => ({ matchEvent: mockMatchEvent }));
vi.mock("../../webhooks/webhook-backlog.store.js", () => ({
  insertEvent: mockInsertEvent,
}));
vi.mock("../../webhooks/webhook-engine.js", () => ({
  triggerConversation: mockTriggerConversation,
}));
vi.mock("../../instances/resolve-agent-id.js", () => ({
  resolveAgentSlug: mockResolveAgentSlug,
}));
vi.mock("../../webhooks/webhook-logger.js", () => ({ webhookLog: mockWebhookLog }));

/* ── import under test ─────────────────────────────────────────── */

import { WebhookController } from "./webhook.controller.js";

/* ── setup ──────────────────────────────────────────────────────── */

let controller: WebhookController;

beforeEach(() => {
  vi.clearAllMocks();
  controller = new WebhookController();
});

/* ── tests ──────────────────────────────────────────────────────── */

describe("WebhookController", () => {
  describe("receiveEvent", () => {
    it("should return { ok: true } immediately regardless of processing outcome", async () => {
      mockFindByWebhookToken.mockResolvedValue(null);
      const result = await controller.receiveEvent("unknown-token", { type: "test" });
      expect(result).toEqual({ ok: true });
    });

    it("should reject payload exceeding max size", async () => {
      const bigPayload = { data: "x".repeat(70_000) };
      const result = await controller.receiveEvent("token", bigPayload);
      expect(result).toEqual({ ok: false, error: "payload too large" });
    });
  });

  describe("processEvent pipeline", () => {
    async function processEvent(token: string, payload: Record<string, unknown>) {
      return (controller as any).processEvent(token, payload);
    }

    it("should drop event when webhook token is unknown", async () => {
      mockFindByWebhookToken.mockResolvedValue(null);
      await processEvent("bad-token", { type: "test" });
      expect(mockWebhookLog.warn).toHaveBeenCalledWith("Webhook", expect.stringContaining("unknown token"));
    });

    it("should drop event when source is disabled", async () => {
      mockFindByWebhookToken.mockResolvedValue({
        source: { name: "HubSpot", enabled: false },
        agentId: "inst-1",
      });
      await processEvent("valid-token", { type: "test" });
      expect(mockWebhookLog.info).toHaveBeenCalledWith("Webhook", expect.stringContaining("disabled"));
    });

    it("should drop event when no definitions are enabled", async () => {
      mockFindByWebhookToken.mockResolvedValue({
        source: { id: "src-1", name: "HubSpot", enabled: true },
        agentId: "inst-1",
      });
      mockListEnabledDefinitions.mockResolvedValue([]);
      await processEvent("valid-token", { type: "test" });
      expect(mockWebhookLog.info).toHaveBeenCalledWith("Webhook", expect.stringContaining("no definitions"));
    });

    it("should drop event when no definition matches", async () => {
      mockFindByWebhookToken.mockResolvedValue({
        source: { id: "src-1", name: "HubSpot", enabled: true },
        agentId: "inst-1",
      });
      mockListEnabledDefinitions.mockResolvedValue([{ id: "def-1" }]);
      mockResolveAgentSlug.mockResolvedValue("test-slug");
      mockMatchEvent.mockResolvedValue(null);

      await processEvent("valid-token", { type: "test" });
      expect(mockWebhookLog.info).toHaveBeenCalledWith("Webhook", expect.stringContaining("no match"));
    });

    describe("action: backlog (default)", () => {
      it("should insert event into backlog when Room is enabled", async () => {
        const matchedDef = { id: "def-1", name: "Order Created", action: "backlog" };
        const payload = { type: "order.created", orderId: 42 };

        mockFindByWebhookToken.mockResolvedValue({
          source: { id: "src-1", name: "HubSpot", enabled: true },
          agentId: "inst-1",
        });
        mockListEnabledDefinitions.mockResolvedValue([matchedDef]);
        mockResolveAgentSlug.mockResolvedValue("test-slug");
        mockMatchEvent.mockResolvedValue(matchedDef);
        mockGetRoomByInstanceId.mockResolvedValue({ enabled: true });
        mockInsertEvent.mockResolvedValue("evt-new");

        await processEvent("valid-token", payload);

        expect(mockInsertEvent).toHaveBeenCalledWith("inst-1", "def-1", payload);
        expect(mockTriggerConversation).not.toHaveBeenCalled();
      });

      it("should drop backlog event when Room is disabled", async () => {
        const matchedDef = { id: "def-1", name: "Order Created", action: "backlog" };
        mockFindByWebhookToken.mockResolvedValue({
          source: { id: "src-1", name: "HubSpot", enabled: true },
          agentId: "inst-1",
        });
        mockListEnabledDefinitions.mockResolvedValue([matchedDef]);
        mockResolveAgentSlug.mockResolvedValue("test-slug");
        mockMatchEvent.mockResolvedValue(matchedDef);
        mockGetRoomByInstanceId.mockResolvedValue(null);

        await processEvent("valid-token", { type: "test" });

        expect(mockInsertEvent).not.toHaveBeenCalled();
        expect(mockWebhookLog.info).toHaveBeenCalledWith("Webhook", expect.stringContaining("room disabled"));
      });
    });

    describe("action: conversation", () => {
      it("should trigger conversation when definition has action: conversation", async () => {
        const matchedDef = {
          id: "def-1",
          name: "New Deal",
          action: "conversation",
          contextPrompt: "Deal: {{payload}}",
          outboundChannel: "whatsapp",
          outboundTarget: "{{payload.phone}}",
        };
        const payload = { phone: "+39111111111", dealId: "123" };

        mockFindByWebhookToken.mockResolvedValue({
          source: { id: "src-1", name: "External System", enabled: true },
          agentId: "inst-1",
        });
        mockListEnabledDefinitions.mockResolvedValue([matchedDef]);
        mockResolveAgentSlug.mockResolvedValue("test-slug");
        mockMatchEvent.mockResolvedValue(matchedDef);
        mockTriggerConversation.mockResolvedValue(undefined);

        await processEvent("valid-token", payload);

        expect(mockTriggerConversation).toHaveBeenCalledWith("inst-1", "test-slug", matchedDef, payload);
        expect(mockInsertEvent).not.toHaveBeenCalled();
        expect(mockGetRoomByInstanceId).not.toHaveBeenCalled();
      });

      it("should trigger conversation in internal mode (no outboundChannel)", async () => {
        const matchedDef = {
          id: "def-internal",
          name: "Internal Action",
          action: "conversation",
          contextPrompt: "Run the internal task with payload {{payload}}",
          outboundChannel: null,
          outboundTarget: null,
        };
        const payload = { foo: "bar" };

        mockFindByWebhookToken.mockResolvedValue({
          source: { id: "src-1", name: "External System", enabled: true },
          agentId: "inst-1",
        });
        mockListEnabledDefinitions.mockResolvedValue([matchedDef]);
        mockResolveAgentSlug.mockResolvedValue("test-slug");
        mockMatchEvent.mockResolvedValue(matchedDef);
        mockTriggerConversation.mockResolvedValue(undefined);

        await processEvent("valid-token", payload);

        expect(mockTriggerConversation).toHaveBeenCalledWith("inst-1", "test-slug", matchedDef, payload);
        expect(mockInsertEvent).not.toHaveBeenCalled();
        expect(mockGetRoomByInstanceId).not.toHaveBeenCalled();
      });

      it("should not require Room to be enabled for conversation action", async () => {
        const matchedDef = {
          id: "def-1",
          name: "New Deal",
          action: "conversation",
          contextPrompt: "Deal context",
          outboundChannel: "whatsapp",
          outboundTarget: "+39111111111",
        };

        mockFindByWebhookToken.mockResolvedValue({
          source: { id: "src-1", name: "External System", enabled: true },
          agentId: "inst-1",
        });
        mockListEnabledDefinitions.mockResolvedValue([matchedDef]);
        mockResolveAgentSlug.mockResolvedValue("test-slug");
        mockMatchEvent.mockResolvedValue(matchedDef);
        mockTriggerConversation.mockResolvedValue(undefined);

        await processEvent("valid-token", { data: "test" });

        // Room should NOT be queried for conversation actions
        expect(mockGetRoomByInstanceId).not.toHaveBeenCalled();
        expect(mockTriggerConversation).toHaveBeenCalled();
      });
    });
  });
});
