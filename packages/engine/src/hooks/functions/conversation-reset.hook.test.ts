// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const SYSTEM_SCOPE = vi.hoisted(() => Symbol("conversation-store:system-scope"));

vi.mock("../../conversations/index.js", () => ({
  SYSTEM_SCOPE,
  conversationStore: {
    renameConversation: vi.fn(async () => true),
    getConversation: vi.fn(async () => null),
  },
}));

import { conversationStore } from "../../conversations/index.js";
import resetHook from "./conversation-reset.hook.js";
import type { HookContext } from "@polyant-ai/plugin-sdk";

const CONV_ID = "acme:whatsapp:+393331112223";
const SUFFIX_RE = new RegExp(`^${CONV_ID.replace("+", "\\+")}#(\\d+)$`);

function ctx(text: string): HookContext {
  return {
    event: "message_received",
    payload: {
      instance: { slug: "acme" },
      conversation: { id: CONV_ID },
      channel: { type: "whatsapp", id: "+393331112223" },
      user: { name: "tester" },
      message: { text },
    },
  } as unknown as HookContext;
}

/** The archive id passed to the (mocked) rename. */
function renamedTo(): string {
  return vi.mocked(conversationStore.renameConversation).mock.calls[0][1];
}

describe("conversation-reset hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(conversationStore.getConversation).mockResolvedValue(null);
    vi.mocked(conversationStore.renameConversation).mockResolvedValue(true);
  });

  it("does nothing on a normal message", async () => {
    const result = await resetHook.handler(ctx("ciao, come stai?"));

    expect(result).toBeUndefined();
    expect(conversationStore.renameConversation).not.toHaveBeenCalled();
  });

  it("does nothing when the keyword is embedded in a longer message", async () => {
    const result = await resetHook.handler(ctx("RESET per favore"));

    expect(result).toBeUndefined();
    expect(conversationStore.renameConversation).not.toHaveBeenCalled();
  });

  it("archives the conversation on an exact, case-insensitive match", async () => {
    const result = await resetHook.handler(ctx("  reset \n"));

    expect(conversationStore.renameConversation).toHaveBeenCalledOnce();
    expect(vi.mocked(conversationStore.renameConversation).mock.calls[0][0]).toBe(CONV_ID);
    expect(renamedTo()).toMatch(/#\d{5}$/);
    expect(result).toEqual({
      halt: { message: expect.stringMatching(/^RESET → #\d{5}$/), persist: false },
    });
  });

  it("looks the candidate up with the explicit system scope, so the collision check is live", async () => {
    // Without a scope the store's org filter fails closed (`and false`), so the
    // lookup would ALWAYS return null and the collision check below would be dead.
    await resetHook.handler(ctx("RESET"));

    expect(conversationStore.getConversation).toHaveBeenCalledWith(
      expect.stringMatching(/#\d{5}$/),
      SYSTEM_SCOPE,
    );
  });

  it("detects an existing conversation and does not reuse its id", async () => {
    const taken = `${CONV_ID}#11111`;
    vi.mocked(conversationStore.getConversation).mockImplementation(
      async (id: string) => (id === taken ? ({ conversationId: id } as never) : null),
    );
    // Force the first candidate onto the taken id, the second onto a free one.
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(1111 / 90000).mockReturnValue(0.5);

    await resetHook.handler(ctx("RESET"));

    expect(conversationStore.getConversation).toHaveBeenCalledTimes(2);
    expect(renamedTo()).not.toBe(taken);
    random.mockRestore();
  });

  it("picks another id when the first candidate is taken", async () => {
    vi.mocked(conversationStore.getConversation)
      .mockResolvedValueOnce({ conversationId: "taken" } as never)
      .mockResolvedValueOnce(null);

    await resetHook.handler(ctx("RESET"));

    expect(conversationStore.getConversation).toHaveBeenCalledTimes(2);
    expect(renamedTo()).toMatch(/#\d{5}$/);
  });

  it("falls back to a timestamp suffix when both candidates are taken", async () => {
    vi.mocked(conversationStore.getConversation).mockResolvedValue({ conversationId: "taken" } as never);

    await resetHook.handler(ctx("RESET"));

    const [, suffixDigits] = SUFFIX_RE.exec(renamedTo()) ?? [];
    expect(suffixDigits?.length).toBeGreaterThan(5);
  });

  it("reports failure instead of claiming success when the rename throws", async () => {
    vi.mocked(conversationStore.renameConversation).mockRejectedValue(new Error("db down"));

    const result = await resetHook.handler(ctx("RESET"));

    expect(result).toEqual({
      halt: { message: "RESET failed — the conversation was not archived.", persist: false },
    });
  });
});
