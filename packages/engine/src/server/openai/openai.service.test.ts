// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIService } from "./openai.service.js";
import type { ChatCompletionMessage, ChatCompletionRequest } from "./openai.types.js";

// Mock the instances store to avoid DB dependency
const { mockListActiveInstances, mockFindInstanceBySlug, mockResolvePrincipalOrgId } =
  vi.hoisted(() => ({
    mockListActiveInstances: vi.fn().mockResolvedValue([]),
    mockFindInstanceBySlug: vi.fn(),
    mockResolvePrincipalOrgId: vi.fn(),
  }));

vi.mock("../../instances/store.js", () => ({
  listActiveInstances: mockListActiveInstances,
  findInstanceBySlug: mockFindInstanceBySlug,
  resolvePrincipalOrgId: mockResolvePrincipalOrgId,
}));

// Mock config to provide DEFAULT_INSTANCE_ID
vi.mock("../../config.js", () => ({
  DEFAULT_INSTANCE_ID: "default-instance",
}));

function makeRequest(
  messages: ChatCompletionMessage[],
  overrides: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: "test-instance",
    messages,
    ...overrides,
  };
}

describe("OpenAIService", () => {
  // -------------------------------------------------------------------------
  // GET /v1/models visibility — the route is reachable with a per-instance API
  // key, so an unscoped list let one agent's key enumerate the whole deployment.
  // -------------------------------------------------------------------------
  describe("listInstances", () => {
    const agentA = { slug: "agent-a", status: "active" };
    const agentB = { slug: "agent-b", status: "active" };

    beforeEach(() => {
      vi.clearAllMocks();
      mockResolvePrincipalOrgId.mockImplementation(async (orgId?: string) => orgId ?? null);
    });

    it("should_return_only_its_own_agent_when_the_caller_is_an_instance_api_key", async () => {
      mockFindInstanceBySlug.mockResolvedValue(agentA);

      const result = await new OpenAIService().listInstances({
        kind: "instance",
        instanceSlug: "agent-a",
      });

      expect(result).toEqual([agentA]);
      expect(mockFindInstanceBySlug).toHaveBeenCalledWith("agent-a");
      // The whole-deployment listing must never run for an instance principal.
      expect(mockListActiveInstances).not.toHaveBeenCalled();
    });

    it("should_return_nothing_when_the_instance_key_agent_is_not_active", async () => {
      mockFindInstanceBySlug.mockResolvedValue({ slug: "agent-a", status: "inactive" });

      const result = await new OpenAIService().listInstances({
        kind: "instance",
        instanceSlug: "agent-a",
      });

      expect(result).toEqual([]);
    });

    it("should_return_only_the_caller_org_agents_when_the_caller_is_a_user", async () => {
      mockListActiveInstances.mockImplementation(async (orgId?: string) =>
        orgId === "org-a" ? [agentA] : [agentA, agentB],
      );

      const result = await new OpenAIService().listInstances({ orgId: "org-a" });

      expect(mockListActiveInstances).toHaveBeenCalledWith("org-a");
      expect(result).toEqual([agentA]);
    });

    it("should_return_nothing_when_the_caller_org_cannot_be_resolved", async () => {
      mockResolvePrincipalOrgId.mockResolvedValue(null);

      const result = await new OpenAIService().listInstances(undefined);

      expect(result).toEqual([]);
      expect(mockListActiveInstances).not.toHaveBeenCalled();
    });
  });

  describe("deriveChannelId", () => {
    // Access private method via casting for testing
    function callDeriveChannelId(
      service: OpenAIService,
      messages: ChatCompletionMessage[],
      chatId?: string,
    ): string {
      return (service as any).deriveChannelId(messages, chatId);
    }

    it("returns api-{chatId} when chatId is provided", () => {
      const service = new OpenAIService();
      const result = callDeriveChannelId(service, [], "my-chat-123");
      expect(result).toBe("api-my-chat-123");
    });

    it("returns a random ID when no chatId but user message exists", () => {
      const service = new OpenAIService();
      const messages: ChatCompletionMessage[] = [
        { role: "user", content: "Hello world" },
      ];
      const result = callDeriveChannelId(service, messages);

      expect(result).toMatch(/^api-[a-f0-9-]{36}$/);
    });

    it("returns different IDs for the same first user message", () => {
      const service = new OpenAIService();
      const messages: ChatCompletionMessage[] = [
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi there" },
      ];
      const result1 = callDeriveChannelId(service, messages);
      const result2 = callDeriveChannelId(service, messages);
      expect(result1).not.toBe(result2);
    });

    it("returns random ID when no user message exists", () => {
      const service = new OpenAIService();
      const messages: ChatCompletionMessage[] = [
        { role: "system", content: "You are a bot" },
      ];
      const result = callDeriveChannelId(service, messages);

      expect(result).toMatch(/^api-[a-f0-9-]{36}$/);
    });
  });

  describe("prepareRequest", () => {
    function callPrepareRequest(
      service: OpenAIService,
      request: ChatCompletionRequest,
    ) {
      return (service as any).prepareRequest(request);
    }

    it("extracts the last user message as text", () => {
      const service = new OpenAIService();
      const request = makeRequest([
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow-up" },
      ]);

      const result = callPrepareRequest(service, request);
      expect(result.text).toBe("follow-up");
    });

    it("builds conversation history from messages before the last user message", () => {
      const service = new OpenAIService();
      const request = makeRequest([
        { role: "system", content: "system prompt" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow-up" },
      ]);

      const result = callPrepareRequest(service, request);
      // system messages are now included by toCoreMessages
      expect(result.conversationHistory).toEqual([
        { role: "system", content: "system prompt" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
      ]);
    });

    it("uses model field as instanceId", () => {
      const service = new OpenAIService();
      const request = makeRequest(
        [{ role: "user", content: "hi" }],
        { model: "my-custom-instance" },
      );

      const result = callPrepareRequest(service, request);
      expect(result.instanceId).toBe("my-custom-instance");
    });

    it("falls back to DEFAULT_INSTANCE_ID when model is empty", () => {
      const service = new OpenAIService();
      const request = makeRequest(
        [{ role: "user", content: "hi" }],
        { model: "" },
      );

      const result = callPrepareRequest(service, request);
      expect(result.instanceId).toBe("default-instance");
    });

    it("returns empty text when no user messages exist", () => {
      const service = new OpenAIService();
      const request = makeRequest([
        { role: "system", content: "system prompt" },
      ]);

      const result = callPrepareRequest(service, request);
      expect(result.text).toBe("");
    });

    it("uses chat_id for channelId when provided", () => {
      const service = new OpenAIService();
      const request = makeRequest(
        [{ role: "user", content: "hi" }],
        { chat_id: "explicit-id" },
      );

      const result = callPrepareRequest(service, request);
      expect(result.channelId).toBe("api-explicit-id");
    });
  });
});
