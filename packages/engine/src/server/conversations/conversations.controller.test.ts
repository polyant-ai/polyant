// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

/**
 * Unit tests for the per-turn debug + conversation-state endpoints on
 * ConversationsController. Focus: the UUID guard, 404 on a missing message,
 * and the cross-instance IDOR guard (a conversation owned by another instance
 * must look like "not found", never leak existence).
 */

const { mockStore, mockLoadConversationState } = vi.hoisted(() => ({
  mockStore: {
    getConversation: vi.fn(),
    getMessageDebug: vi.fn(),
    listConversations: vi.fn(),
    searchConversations: vi.fn(),
    renameConversation: vi.fn(),
  },
  mockLoadConversationState: vi.fn(),
}));

vi.mock("../../conversations/store.js", () => ({ conversationStore: mockStore }));
vi.mock("../../conversations/state.store.js", () => ({ loadConversationState: mockLoadConversationState }));

import { ConversationsController } from "./conversations.controller.js";

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("ConversationsController — debug + state endpoints", () => {
  let controller: ConversationsController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ConversationsController();
  });

  describe("getMessageDebug", () => {
    it("returns the debug payload for a message in an owned conversation", async () => {
      mockStore.getConversation.mockResolvedValue({ instanceId: "acme" });
      const debug = { debugPayload: { system: "s", messages: [], tools: [] }, steps: null };
      mockStore.getMessageDebug.mockResolvedValue(debug);

      const result = await controller.getMessageDebug("acme:web:api-1", VALID_UUID, "acme");
      expect(result).toEqual(debug);
    });

    it("rejects a non-UUID message id with 400 before touching the store", async () => {
      await expect(
        controller.getMessageDebug("acme:web:api-1", "not-a-uuid", "acme"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStore.getConversation).not.toHaveBeenCalled();
    });

    it("returns 404 when the message is not in the conversation", async () => {
      mockStore.getConversation.mockResolvedValue({ instanceId: "acme" });
      mockStore.getMessageDebug.mockResolvedValue(null);

      await expect(
        controller.getMessageDebug("acme:web:api-1", VALID_UUID, "acme"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns 404 (IDOR guard) when the conversation belongs to another instance", async () => {
      mockStore.getConversation.mockResolvedValue({ instanceId: "other" });

      await expect(
        controller.getMessageDebug("acme:web:api-1", VALID_UUID, "acme"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStore.getMessageDebug).not.toHaveBeenCalled();
    });

    it("requires an instanceId", async () => {
      await expect(
        controller.getMessageDebug("acme:web:api-1", VALID_UUID, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("list — updatedSince/updatedUntil window", () => {
    beforeEach(() => {
      mockStore.listConversations.mockResolvedValue({ conversations: [], total: 0 });
    });

    it("parses ISO datetimes and passes Date objects to the store", async () => {
      await controller.list("acme", undefined, undefined, undefined, undefined,
        "2026-07-01T00:00:00Z", "2026-07-14T00:00:00Z", undefined);

      expect(mockStore.listConversations).toHaveBeenCalledTimes(1);
      const opts = mockStore.listConversations.mock.calls[0][0];
      expect(opts.updatedSince).toBeInstanceOf(Date);
      expect(opts.updatedUntil).toBeInstanceOf(Date);
      expect(opts.updatedSince.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    });

    it("leaves the window undefined when the params are absent", async () => {
      await controller.list("acme", undefined, undefined, undefined, undefined, undefined, undefined, undefined);

      const opts = mockStore.listConversations.mock.calls[0][0];
      expect(opts.updatedSince).toBeUndefined();
      expect(opts.updatedUntil).toBeUndefined();
    });

    it("rejects a malformed updatedSince with 400 before touching the store", async () => {
      await expect(
        controller.list("acme", undefined, undefined, undefined, undefined, "not-a-date", undefined, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStore.listConversations).not.toHaveBeenCalled();
    });
  });

  describe("rename", () => {
    it("propagates a new id + title and returns the target id", async () => {
      // 1st getConversation = scope load; 2nd = conflict pre-check (free).
      mockStore.getConversation
        .mockResolvedValueOnce({ instanceId: "acme" })
        .mockResolvedValueOnce(null);
      mockStore.renameConversation.mockResolvedValue(true);

      const result = await controller.rename(
        "acme:whatsapp:%2B3900",
        { conversationId: "acme:whatsapp:archived-1", title: "Round 1" },
        "acme",
      );

      expect(result).toEqual({ renamed: true, conversationId: "acme:whatsapp:archived-1" });
      expect(mockStore.renameConversation).toHaveBeenCalledWith(
        "acme:whatsapp:+3900",
        "acme:whatsapp:archived-1",
        "Round 1",
      );
    });

    it("rejects a new id whose prefix is not the instance slug (routing/IDOR guard)", async () => {
      mockStore.getConversation.mockResolvedValueOnce({ instanceId: "acme" });

      await expect(
        controller.rename("acme:web:api-1", { conversationId: "evil:web:api-1" }, "acme"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStore.renameConversation).not.toHaveBeenCalled();
    });

    it("returns 409 when the target id is already in use", async () => {
      mockStore.getConversation
        .mockResolvedValueOnce({ instanceId: "acme" })
        .mockResolvedValueOnce({ instanceId: "acme" }); // conflict: target exists

      await expect(
        controller.rename("acme:web:api-1", { conversationId: "acme:web:api-2" }, "acme"),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockStore.renameConversation).not.toHaveBeenCalled();
    });

    it("rejects an explicitly empty title", async () => {
      mockStore.getConversation.mockResolvedValueOnce({ instanceId: "acme" });

      await expect(
        controller.rename("acme:web:api-1", { title: "   " }, "acme"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStore.renameConversation).not.toHaveBeenCalled();
    });

    it("allows a title-only edit (id unchanged, no conflict check)", async () => {
      mockStore.getConversation.mockResolvedValueOnce({ instanceId: "acme" });
      mockStore.renameConversation.mockResolvedValue(true);

      const result = await controller.rename("acme:web:api-1", { title: "New title" }, "acme");

      expect(result).toEqual({ renamed: true, conversationId: "acme:web:api-1" });
      // getConversation called once (scope load only — no conflict pre-check).
      expect(mockStore.getConversation).toHaveBeenCalledTimes(1);
      expect(mockStore.renameConversation).toHaveBeenCalledWith(
        "acme:web:api-1",
        "acme:web:api-1",
        "New title",
      );
    });

    it("returns 404 (IDOR guard) for a conversation owned by another instance", async () => {
      mockStore.getConversation.mockResolvedValueOnce({ instanceId: "other" });

      await expect(
        controller.rename("acme:web:api-1", { title: "x" }, "acme"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStore.renameConversation).not.toHaveBeenCalled();
    });
  });

  describe("getState", () => {
    it("returns the conversation state snapshot for an owned conversation", async () => {
      mockStore.getConversation.mockResolvedValue({ instanceId: "acme" });
      mockLoadConversationState.mockResolvedValue({ _channel: { type: "web", id: "u1" }, foo: "bar" });

      const result = await controller.getState("acme:web:api-1", "acme");
      expect(result).toEqual({ state: { _channel: { type: "web", id: "u1" }, foo: "bar" } });
    });

    it("returns 404 (IDOR guard) for a conversation owned by another instance", async () => {
      mockStore.getConversation.mockResolvedValue({ instanceId: "other" });

      await expect(controller.getState("acme:web:api-1", "acme")).rejects.toBeInstanceOf(NotFoundException);
      expect(mockLoadConversationState).not.toHaveBeenCalled();
    });
  });
});
