// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A summary refresh pays for its call only while the marker it was planned on
 * still stands in the database, and is never held back by another refresh in
 * flight: the compare-and-set write decides which lands. A process-local lock on
 * the refresh would block it after a write that matched no row, or forever behind
 * a call that never settles, and then the window keeps growing until it expires.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChat, mockUpdateSummary, mockGetSummaryThrough, mockExtractMemories } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  /** Runs after the summary step: its call marks the end of the refresh. */
  mockExtractMemories: vi.fn(async (..._args: unknown[]) => undefined),
  mockUpdateSummary: vi.fn(async (..._args: unknown[]) => true),
  /** The stored marker the refresh reads again before its summary call. */
  mockGetSummaryThrough: vi.fn(async (..._args: unknown[]): Promise<number | null | undefined> => 5),
}));

vi.mock("./ai-gateway/index.js", () => ({ chat: mockChat }));
vi.mock("./conversations/index.js", () => ({
  conversationStore: {
    appendMessages: vi.fn(async () => undefined),
    getSystemMessageContents: vi.fn(async () => new Set<string>()),
    updateSummary: mockUpdateSummary,
    getSummaryThrough: mockGetSummaryThrough,
  },
}));
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: vi.fn(async () => undefined) }));
vi.mock("./memory/index.js", () => ({ extractMemories: mockExtractMemories }));

import { afterResponse } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";

/** Run the post-response work of a turn that planned a refresh from marker `expected`. */
function respond(conversationId: string, expected: number | null, cover = true) {
  afterResponse({
    conversationId,
    instanceId: asInstanceSlug("shop"),
    userMessage: "u",
    assistantResponse: "a",
    needsSummaryUpdate: true,
    droppedMessages: [{ role: "user", content: "u5" }, { role: "assistant", content: "a5" }],
    ...(cover ? { summaryCover: { expected, through: (expected ?? 0) + 5 } } : {}),
    memoryEnabled: true,
  });
}

describe("afterResponse — summary refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGetSummaryThrough.mockResolvedValue(5);
  });

  /** Wait until `turns` post-response runs are past the summary step (memory extraction follows it). */
  const settle = (turns = 1) => vi.waitFor(() => expect(mockExtractMemories).toHaveBeenCalledTimes(turns));

  it("skips the paid summary call when the marker moved after the window was planned", async () => {
    // The previous turn's refresh landed (5 -> 10) while this turn was answering.
    mockGetSummaryThrough.mockResolvedValue(10);
    mockChat.mockResolvedValue({ text: "summary" });
    respond("c-moved", 5);
    await settle();
    expect(mockGetSummaryThrough).toHaveBeenCalledWith("c-moved");
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockUpdateSummary).not.toHaveBeenCalled();
  });

  it("skips the paid summary call when the marker cannot be read, or the conversation is gone", async () => {
    mockChat.mockResolvedValue({ text: "summary" });
    mockGetSummaryThrough.mockRejectedValueOnce(new Error("db down"));
    respond("c-unread", 5);
    await settle();
    mockGetSummaryThrough.mockResolvedValueOnce(undefined);
    respond("c-gone", null);
    await settle(2);
    expect(mockGetSummaryThrough).toHaveBeenCalledTimes(2);
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockUpdateSummary).not.toHaveBeenCalled();
  });

  it("refreshes from a null marker that still stands", async () => {
    mockGetSummaryThrough.mockResolvedValue(null);
    mockChat.mockResolvedValue({ text: "summary" });
    respond("c-null", null);
    await vi.waitFor(() => expect(mockUpdateSummary).toHaveBeenCalledWith("c-null", "summary", { expected: null, through: 5 }));
  });

  it("refreshes without a marker read when the turn planned no marker move", async () => {
    mockChat.mockResolvedValue({ text: "summary" });
    respond("c-plain", 5, false);
    await settle();
    expect(mockUpdateSummary).toHaveBeenCalledWith("c-plain", "summary", undefined);
    expect(mockGetSummaryThrough).not.toHaveBeenCalled();
  });

  it("runs a refresh planned on a marker whose previous write matched no row", async () => {
    mockChat.mockResolvedValue({ text: "summary" });
    mockUpdateSummary.mockResolvedValueOnce(false);
    respond("c-miss", 5);
    await vi.waitFor(() => expect(mockUpdateSummary).toHaveBeenCalledTimes(1));
    respond("c-miss", 5);
    await vi.waitFor(() => expect(mockUpdateSummary).toHaveBeenCalledTimes(2));
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockUpdateSummary).toHaveBeenLastCalledWith("c-miss", "summary", { expected: 5, through: 10 });
  });

  it("runs a refresh while another on the same marker is still waiting for its summary call", async () => {
    mockChat.mockImplementationOnce(() => new Promise(() => {}));
    respond("c-hung", 5);
    await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    mockChat.mockResolvedValue({ text: "summary" });
    respond("c-hung", 5);
    await vi.waitFor(() => expect(mockUpdateSummary).toHaveBeenCalledTimes(1));
    expect(mockUpdateSummary).toHaveBeenCalledWith("c-hung", "summary", { expected: 5, through: 10 });
  });
});
