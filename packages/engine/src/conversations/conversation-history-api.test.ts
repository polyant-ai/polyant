// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";

const getRecentMessages = vi.hoisted(() => vi.fn());
vi.mock("./store.js", () => ({
  conversationStore: { getRecentMessages: (...a: unknown[]) => getRecentMessages(...a) },
}));

import { buildConversationApi } from "./conversation-history-api.js";

const FEED: ModelMessage[] = [
  { role: "system", content: "sei un assistente" },
  { role: "user", content: "vorrei una pulizia" },
  { role: "assistant", content: "certo, dove?" },
  { role: "user", content: "a Milano" },
] as ModelMessage[];

describe("buildConversationApi", () => {
  beforeEach(() => {
    getRecentMessages.mockReset();
    getRecentMessages.mockResolvedValue(FEED);
  });

  it("should_return_messages_oldest_to_newest_and_take_last_n", async () => {
    const api = buildConversationApi("conv-1");
    const msgs = await api.getRecentMessages(2);
    expect(msgs.map((m) => m.content)).toEqual(["certo, dove?", "a Milano"]);
  });

  it("should_filter_by_role_before_the_n_cut", async () => {
    const api = buildConversationApi("conv-1");
    const msgs = await api.getRecentMessages(2, { roles: ["user"] });
    expect(msgs.map((m) => m.content)).toEqual(["vorrei una pulizia", "a Milano"]);
  });

  it("should_return_all_matching_when_n_is_zero_and_none_when_negative", async () => {
    const api = buildConversationApi("conv-1");
    expect((await api.getRecentMessages(0)).length).toBe(4);
    expect((await api.getRecentMessages(-1)).length).toBe(0);
  });

  it("should_drop_non_string_multimodal_content", async () => {
    getRecentMessages.mockResolvedValue([
      { role: "user", content: "testo" },
      { role: "user", content: [{ type: "image", image: "…" }] },
    ] as unknown as ModelMessage[]);
    const api = buildConversationApi("conv-1");
    const msgs = await api.getRecentMessages(10);
    expect(msgs.map((m) => m.content)).toEqual(["testo"]);
  });
});
