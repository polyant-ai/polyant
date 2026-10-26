// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The turn reads the conversation's recent messages once. An agent with
 * tool-result replay on used to run the same ordered query twice: text first,
 * then the raw rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetRecentMessages, mockSnapshot, mockResolveConfig } = vi.hoisted(() => ({
  mockGetRecentMessages: vi.fn(),
  mockSnapshot: vi.fn(),
  mockResolveConfig: vi.fn(),
}));

vi.mock("./conversations/index.js", () => ({
  conversationStore: {
    ensureConversation: vi.fn(async () => ({ created: false })),
    getRecentMessages: mockGetRecentMessages,
    getHistorySnapshot: mockSnapshot,
    getContextPrompt: vi.fn(async () => null),
  },
}));
vi.mock("./conversations/state.buffer.js", () => ({
  ConversationStateBuffer: class {
    static load = vi.fn(async () => new this());
    seedChannel() {}
  },
}));
vi.mock("./instances/config-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instances/config-resolver.js")>()),
  resolveInstanceConfig: mockResolveConfig,
}));
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
  cacheConfig: { enabled: true, ttl: "1h" },
});

describe("preparePipeline — recent messages are read once", () => {
  const state = { summary: null, summaryThrough: null, userMessageCount: 1 };
  const textRows = [{ role: "user", content: "hi", createdAt: null }];
  const replayRows = [
    { role: "user", content: "hi", steps: null, reasoning: null, createdAt: null },
    { role: "assistant", content: "hello", steps: null, reasoning: null, createdAt: null },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSnapshot.mockImplementation(async (_id: string, _limit: number, opts?: { steps?: boolean }) => ({
      rows: opts?.steps ? replayRows : textRows,
      ...state,
    }));
  });

  it("reads only the rows when tool-result replay is on", async () => {
    mockResolveConfig.mockResolvedValue(config(true));

    const ctx = await preparePipeline(msg);

    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSnapshot.mock.calls[0][2]).toEqual({ steps: true });
    expect(mockGetRecentMessages).not.toHaveBeenCalled();
    expect(ctx.isFirstTurn).toBe(false);
    expect(ctx.history).toHaveLength(2);
  });

  it("reads only the text history when replay is off", async () => {
    mockResolveConfig.mockResolvedValue(config(false));

    const ctx = await preparePipeline(msg);

    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSnapshot.mock.calls[0][2]).toBeUndefined();
    expect(ctx.history).toEqual([{ role: "user", content: "hi" }]);
  });

  it("falls back to the text history when the row read fails", async () => {
    mockResolveConfig.mockResolvedValue(config(true));
    mockSnapshot.mockRejectedValueOnce(new Error("db"));

    const ctx = await preparePipeline(msg);

    expect(ctx.isFirstTurn).toBe(false);
    expect(ctx.history).toEqual([{ role: "user", content: "hi" }]);
  });
});
