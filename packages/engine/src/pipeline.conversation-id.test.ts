// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which conversation a turn belongs to. An adapter can name it (one Slack
 * conversation per thread), while a request-supplied metadata key cannot:
 * metadata travels from untrusted callers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockResolveConfig } = vi.hoisted(() => ({ mockResolveConfig: vi.fn() }));

vi.mock("./conversations/index.js", () => ({
  conversationStore: {
    openConversationTurn: vi.fn(async () => ({ created: false, contextPrompt: null, summary: null, summaryThrough: null })),
    getHistoryWindow: vi.fn(async () => []),
  },
}));
vi.mock("./conversations/state.buffer.js", () => ({
  ConversationStateBuffer: class {
    static load = vi.fn(async () => new this());
    seedChannel() {}
  },
}));
vi.mock("./instances/config-resolver.js", () => ({ resolveInstanceConfig: mockResolveConfig }));
vi.mock("./activity-stream/emit-helpers.js", () => ({ resolveInstanceMeta: vi.fn(async () => undefined) }));
vi.mock("./activity-stream/emitters/emit-inbound.js", () => ({ emitInbound: vi.fn() }));
vi.mock("./activity-stream/emitters/emit-conversation.js", () => ({ emitConversation: vi.fn() }));

import { preparePipeline } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import type { IncomingMessage } from "./channels/types.js";

const mention = (extra: Partial<IncomingMessage>): IncomingMessage => ({
  instanceId: asInstanceSlug("team"),
  channelType: "slack",
  channelId: "C42",
  userName: "u",
  text: "status?",
  metadata: {},
  ...extra,
});

describe("preparePipeline — the turn's conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfig.mockResolvedValue({ toolResultsInHistoryEnabled: false, langsmith: { enabled: false } });
  });

  it("keeps two threads of one channel in two conversations when the adapter names them", async () => {
    const a = await preparePipeline(mention({ conversationId: "team:slack:C42:100.0" }));
    const b = await preparePipeline(mention({ conversationId: "team:slack:C42:150.0" }));

    expect(a.conversationId).toBe("team:slack:C42:100.0");
    expect(b.conversationId).toBe("team:slack:C42:150.0");
  });

  it("ignores a conversation id smuggled in through metadata", async () => {
    const ctx = await preparePipeline(mention({ metadata: { conversationIdOverride: "other:web:victim" } }));

    expect(ctx.conversationId).toBe("team:slack:C42");
  });

  it("lets the caller's explicit conversation win over the adapter's", async () => {
    const ctx = await preparePipeline(mention({ conversationId: "team:slack:C42:100.0" }), "team:slack:U7");

    expect(ctx.conversationId).toBe("team:slack:U7");
  });
});
