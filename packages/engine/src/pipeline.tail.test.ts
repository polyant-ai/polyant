// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every turn after the history passes its window computes the same fold of its
 * oldest messages until one lands. Each of those turns used to queue its own
 * summary call, paid for and then thrown away by the conditional update, and in
 * a backlog the redundant calls made the queue that produced them longer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChat, mockGetSummaryThrough, mockAdvanceSummary } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockGetSummaryThrough: vi.fn(async (_conversationId: string): Promise<Date | null> => null),
  mockAdvanceSummary: vi.fn(async () => true),
}));

vi.mock("./ai-gateway/index.js", () => ({ chat: mockChat }));
vi.mock("./conversations/index.js", () => ({
  conversationStore: { getSummaryThrough: mockGetSummaryThrough, advanceSummary: mockAdvanceSummary },
}));
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: vi.fn(async () => undefined) }));
vi.mock("./memory/index.js", () => ({ extractMemories: vi.fn(async () => []) }));

import { afterResponseTail, type TurnTailOptions } from "./pipeline.js";
import { drainBackgroundTurns } from "./channels/background-turns.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import type { InstanceConfig } from "./instances/config-resolver.js";

const folded = new Date("2026-11-04T10:00:00.000Z");

function tail(conversationId: string, previousThrough: Date | null = null): TurnTailOptions {
  return {
    conversationId,
    instanceId: asInstanceSlug("agent"),
    instanceConfig: { memoryEnabled: false, langsmith: { enabled: false } } as InstanceConfig,
    summaryFold: { messages: [{ role: "user", content: "an old message" }], through: folded, previousThrough },
  };
}

describe("afterResponseTail — the summary fold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSummaryThrough.mockResolvedValue(null);
  });

  it("makes one summary call when several turns queue the same fold", async () => {
    let answer!: (value: { text: string }) => void;
    mockChat.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

    afterResponseTail(tail("conv-backlog"));
    await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    afterResponseTail(tail("conv-backlog"));
    afterResponseTail(tail("conv-backlog"));
    answer({ text: "summary" });
    await drainBackgroundTurns(1_000);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockAdvanceSummary).toHaveBeenCalledTimes(1);
  });

  it("makes no summary call when the summary has moved since the turn read it", async () => {
    mockGetSummaryThrough.mockResolvedValue(new Date("2026-11-04T09:59:00.000Z"));

    afterResponseTail(tail("conv-moved"));
    await drainBackgroundTurns(1_000);

    expect(mockChat).not.toHaveBeenCalled();
  });

  it("folds again once the previous fold has finished", async () => {
    mockChat.mockResolvedValue({ text: "summary" });

    afterResponseTail(tail("conv-later"));
    await drainBackgroundTurns(1_000);
    mockGetSummaryThrough.mockResolvedValue(folded);
    afterResponseTail(tail("conv-later", folded));
    await drainBackgroundTurns(1_000);

    expect(mockChat).toHaveBeenCalledTimes(2);
  });
});
