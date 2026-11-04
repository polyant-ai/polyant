// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The body the playground sends on a long conversation. The engine refuses a
 * request carrying more than a hundred messages, so a session that has grown past
 * that, or a long conversation reopened from the history, must still produce a
 * request it accepts, ending with the message just typed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const ENGINE_MESSAGE_LIMIT = 100;

vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (key: string) => key, locale: "en" }) }));
vi.mock("@/lib/activity-stream/own-playground-chats", () => ({ rememberPlaygroundChat: () => {} }));

const loaded = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    conversations: {
      messages: async () => ({ messages: loaded.messages }),
      hookExecutions: async () => ({ executions: [] }),
    },
  },
}));

import { useChat } from "./use-chat";

type SentBody = { messages: { role: string; content: string }[]; chat_id: string };
const sent: SentBody[] = [];

function answering(reply: string) {
  return async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string) as SentBody);
    const sse = `event: text-delta\ndata: {"text":"${reply}"}\n\nevent: done\ndata: {}\n\n`;
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
}

async function send(result: { current: ReturnType<typeof useChat> }, text: string) {
  act(() => result.current.sendMessage(text));
  await waitFor(() => expect(result.current.state.isStreaming).toBe(false));
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("fetch", vi.fn(answering("ok")));
});

describe("playground request on a long conversation", () => {
  it("still sends an acceptable request after fifty exchanges", async () => {
    const { result } = renderHook(() => useChat("agent"));
    for (let i = 0; i < 50; i++) await send(result, `question ${i}`);
    await send(result, "question 50");

    const body = sent.at(-1)!;
    expect(body.messages.length).toBeLessThanOrEqual(ENGINE_MESSAGE_LIMIT);
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "question 50" });
    // The most recent exchanges are the ones kept.
    expect(body.messages.at(-3)).toEqual({ role: "user", content: "question 49" });
    expect(body.messages.at(-2)).toEqual({ role: "assistant", content: "ok" });
    expect(new Set(sent.map((b) => b.chat_id)).size).toBe(1);
  });

  it("still sends an acceptable request on a conversation reopened from the history", async () => {
    loaded.messages = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      createdAt: null,
    }));
    const { result } = renderHook(() => useChat("agent"));
    await act(() => result.current.loadConversation("agent:web:api-chat-1", "agent"));
    await send(result, "one more question");

    const body = sent.at(-1)!;
    expect(body.chat_id).toBe("chat-1");
    expect(body.messages.length).toBeLessThanOrEqual(ENGINE_MESSAGE_LIMIT);
    expect(body.messages.at(-2)).toEqual({ role: "assistant", content: "message 99" });
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "one more question" });
  });
});
