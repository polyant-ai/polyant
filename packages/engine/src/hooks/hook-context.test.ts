// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConversationHistoryApi, AuditLogger } from "@polyant-ai/plugin-sdk";
import type { HookEventPayload, HookRunContext } from "./hook-types.js";
import { asAgentSlug } from "../instances/identifiers.js";

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock("../ai-gateway/index.js", () => ({ chat: mockChat }));

// Imported after the mock so the module under test binds the mocked `chat`.
const { buildHookContext } = await import("./hook-context.js");

const conversation: ConversationHistoryApi = { getRecentMessages: async () => [] };
const audit: AuditLogger = { log: () => {} };

const payload: HookEventPayload = {
  instance: { slug: "acme" },
  conversation: { id: "conv-1" },
  channel: { type: "web", id: "web-1" },
  user: { name: "Alice" },
  message: { text: "hi" },
};

function baseCtx(overrides: Partial<HookRunContext> = {}): HookRunContext {
  return {
    instanceId: asAgentSlug("acme"),
    conversationId: "conv-1",
    secrets: {},
    provider: "anthropic",
    model: "claude-x",
    apiKeys: { anthropic: "sk-test" },
    ...overrides,
  };
}

describe("buildHookContext", () => {
  beforeEach(() => {
    mockChat.mockReset();
  });

  it("should_call_gateway_with_standard_tier_and_instance_provider_when_ai_chat_invoked", async () => {
    mockChat.mockResolvedValue({ text: "hello back" });
    const ctx = buildHookContext("message_received", payload, baseCtx(), conversation, audit);

    const out = await ctx.ai.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(out).toBe("hello back");
    expect(mockChat).toHaveBeenCalledTimes(1);
    const [request, options] = mockChat.mock.calls[0];
    expect(request.tier).toBe("standard");
    expect(request.provider).toBe("anthropic");
    expect(request.model).toBe("claude-x");
    expect(request.apiKeys).toEqual({ anthropic: "sk-test" });
    expect(request.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(options).toMatchObject({ conversationId: "conv-1", instanceId: "acme", callType: "service" });
  });

  it("should_forward_explicit_tier_and_system", async () => {
    mockChat.mockResolvedValue({ text: "ok" });
    const ctx = buildHookContext("message_received", payload, baseCtx(), conversation, audit);

    await ctx.ai.chat({ messages: [{ role: "user", content: "q" }], system: "be terse", tier: "fast" });

    const [request] = mockChat.mock.calls[0];
    expect(request.tier).toBe("fast");
    expect(request.system).toBe("be terse");
  });

  it("should_expose_no_op_state_when_run_context_state_is_undefined", () => {
    const ctx = buildHookContext("message_received", payload, baseCtx({ state: undefined }), conversation, audit);

    expect(() => ctx.state.get("k")).not.toThrow();
    expect(ctx.state.get("k")).toBeUndefined();
    expect(ctx.state.getAll()).toEqual({});
    expect(ctx.state.channel).toBeUndefined();
    expect(() => ctx.state.set("k", "v")).not.toThrow();
    expect(() => ctx.state.delete("k")).not.toThrow();
  });

  it("should_default_flags_to_empty_object_when_absent", () => {
    const ctx = buildHookContext("message_received", payload, baseCtx({ flags: undefined }), conversation, audit);
    expect(ctx.instance.flags).toEqual({});
    expect(ctx.instance.slug).toBe("acme");
    expect(ctx.instance.model).toBe("claude-x");
  });
});
