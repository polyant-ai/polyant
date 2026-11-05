// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The turn reads the conversation's history once, starting where the summary
 * reaches. An agent with tool-result replay on used to run the same ordered
 * query twice: text first, then the raw rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetHistoryWindow, mockOpenTurn, mockResolveConfig } = vi.hoisted(() => ({
  mockGetHistoryWindow: vi.fn(),
  mockOpenTurn: vi.fn(),
  mockResolveConfig: vi.fn(),
}));

vi.mock("./conversations/index.js", () => ({
  conversationStore: {
    openConversationTurn: mockOpenTurn,
    getHistoryWindow: mockGetHistoryWindow,
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

const msg = {
  instanceId: asInstanceSlug("shop"),
  channelType: "web",
  channelId: "c1",
  userName: "u",
  text: "ciao",
  metadata: {},
} as never;

const config = (replay: boolean) => ({
  toolResultsInHistoryEnabled: replay,
  langsmith: { enabled: false },
});

const summaryThrough = new Date("2026-11-01T10:00:00.000Z");

describe("preparePipeline — the history is read once, after the summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenTurn.mockResolvedValue({ created: false, contextPrompt: null, summary: "earlier", summaryThrough });
    mockGetHistoryWindow.mockResolvedValue([
      { role: "user", content: "hi", createdAt: new Date("2026-11-01T10:01:00.000Z") },
      { role: "assistant", content: "hello", createdAt: new Date("2026-11-01T10:01:01.000Z") },
    ]);
  });

  it("reads the rows with their steps when tool-result replay is on", async () => {
    mockResolveConfig.mockResolvedValue(config(true));

    const ctx = await preparePipeline(msg);

    expect(mockGetHistoryWindow).toHaveBeenCalledOnce();
    expect(mockGetHistoryWindow).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ after: summaryThrough, withSteps: true }));
    expect(ctx.isFirstTurn).toBe(false);
    expect(ctx.history).toHaveLength(2);
  });

  it("reads the text only when replay is off, and sends the summary with it", async () => {
    mockResolveConfig.mockResolvedValue(config(false));

    const ctx = await preparePipeline(msg);

    expect(mockGetHistoryWindow).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ withSteps: false }));
    expect(ctx.history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(ctx.conversationSummary).toBe("earlier");
  });
});
