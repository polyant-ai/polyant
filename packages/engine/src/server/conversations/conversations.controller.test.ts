// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";

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
