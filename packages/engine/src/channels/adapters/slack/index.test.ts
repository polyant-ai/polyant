// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MessageHandler, OutgoingMessage } from "../../types.js";
import { asInstanceSlug } from "../../../instances/identifiers.js";

type CapturedHandlers = {
  message?: (args: { message: unknown; say: ReturnType<typeof vi.fn>; client: unknown }) => Promise<void>;
  appMention?: (args: { event: unknown; say: ReturnType<typeof vi.fn>; client: unknown }) => Promise<void>;
};

const captured: CapturedHandlers = {};

const usersInfoMock = vi.fn();
const authTestMock = vi.fn();
const conversationsOpenMock = vi.fn();
const chatPostMessageMock = vi.fn();
const startMock = vi.fn().mockResolvedValue(undefined);
const stopMock = vi.fn().mockResolvedValue(undefined);

const fakeClient = {
  auth: { test: authTestMock },
  users: { info: usersInfoMock },
  conversations: { open: conversationsOpenMock },
  chat: { postMessage: chatPostMessageMock },
};

vi.mock("@slack/bolt", () => {
  return {
    App: class {
      client = fakeClient;
      message(handler: NonNullable<CapturedHandlers["message"]>) {
        captured.message = handler;
      }
      event(name: string, handler: NonNullable<CapturedHandlers["appMention"]>) {
        if (name === "app_mention") captured.appMention = handler;
      }
      start = startMock;
      stop = stopMock;
    },
  };
});

const { SlackAdapter } = await import("./index.js");

const BOT_USER_ID = "UBOT123";

const makeAdapter = (onMessage: MessageHandler) => {
  const adapter = new SlackAdapter(asInstanceSlug("inst-test"), {
    botToken: "xoxb-test",
    appToken: "xapp-test",
    signingSecret: "secret",
  });
  return { adapter, init: () => adapter.initialize(onMessage) };
};

const reply: OutgoingMessage = { text: "pong" };

beforeEach(() => {
  captured.message = undefined;
  captured.appMention = undefined;
  authTestMock.mockReset().mockResolvedValue({ ok: true, user_id: BOT_USER_ID, user: "agent-bot" });
  usersInfoMock.mockReset().mockResolvedValue({
    ok: true,
    user: { real_name: "Mario Rossi", profile: { display_name: "mario", real_name: "Mario Rossi" } },
  });
  conversationsOpenMock.mockReset();
  chatPostMessageMock.mockReset();
  startMock.mockClear();
  stopMock.mockClear();
});

describe("SlackAdapter — initialization", () => {
  it("registers both message and app_mention handlers", async () => {
    const onMessage = vi.fn();
    const { init } = makeAdapter(onMessage);
    await init();

    expect(captured.message).toBeTypeOf("function");
    expect(captured.appMention).toBeTypeOf("function");
    expect(authTestMock).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledOnce();
  });

  it("throws if auth.test does not return user_id", async () => {
    authTestMock.mockResolvedValueOnce({ ok: false });
    const { init } = makeAdapter(vi.fn());
    await expect(init()).rejects.toThrow(/auth\.test/);
  });
});

describe("SlackAdapter — DM handling (.message)", () => {
  it("ignores messages with a subtype (e.g. channel_join)", async () => {
    const onMessage = vi.fn();
    const { init } = makeAdapter(onMessage);
    await init();

    const say = vi.fn();
    await captured.message!({
      message: { subtype: "channel_join", text: "hello", user: "U1", channel: "C1", ts: "1.0" },
      say,
      client: fakeClient,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("ignores channel messages without a mention (channel_type !== im)", async () => {
    const onMessage = vi.fn();
    const { init } = makeAdapter(onMessage);
    await init();

    const say = vi.fn();
    await captured.message!({
      message: { channel_type: "channel", text: "ciao a tutti", user: "U1", channel: "C1", ts: "1.0" },
      say,
      client: fakeClient,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("ignores echoes from other bots (bot_id present)", async () => {
    const onMessage = vi.fn();
    const { init } = makeAdapter(onMessage);
    await init();

    const say = vi.fn();
    await captured.message!({
      message: { channel_type: "im", bot_id: "BX", text: "ping", user: "U1", channel: "D1", ts: "1.0" },
      say,
      client: fakeClient,
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("forwards DMs to the pipeline with userName and conversationIdOverride", async () => {
    const onMessage = vi.fn().mockResolvedValue(reply);
    const { init } = makeAdapter(onMessage);
    await init();

    const say = vi.fn();
    await captured.message!({
      message: {
        channel_type: "im",
        text: "ciao",
        user: "U1",
        channel: "D1",
        ts: "1.5",
      },
      say,
      client: fakeClient,
    });

    expect(onMessage).toHaveBeenCalledOnce();
    const incoming = onMessage.mock.calls[0][0];
    expect(incoming).toMatchObject({
      channelType: "slack",
      channelId: "D1",
      instanceId: "inst-test",
      userName: "mario",
      text: "ciao",
    });
    expect(incoming.metadata.conversationIdOverride).toBe("inst-test:slack:D1");
    expect(incoming.metadata.ts).toBe("1.5");
    expect(say).toHaveBeenCalledWith({ text: "pong", thread_ts: undefined });
  });

  it("caches users.info results across messages", async () => {
    const onMessage = vi.fn().mockResolvedValue(reply);
    const { init } = makeAdapter(onMessage);
    await init();

    const baseMsg = { channel_type: "im", text: "hi", user: "U1", channel: "D1" };
    await captured.message!({ message: { ...baseMsg, ts: "1.0" }, say: vi.fn(), client: fakeClient });
    await captured.message!({ message: { ...baseMsg, ts: "2.0" }, say: vi.fn(), client: fakeClient });

    expect(usersInfoMock).toHaveBeenCalledOnce();
  });

  it("falls back to user id if users.info fails", async () => {
    usersInfoMock.mockRejectedValueOnce(new Error("rate limited"));
    const onMessage = vi.fn().mockResolvedValue(reply);
    const { init } = makeAdapter(onMessage);
    await init();

    await captured.message!({
      message: { channel_type: "im", text: "ciao", user: "UFAIL", channel: "D1", ts: "1.0" },
      say: vi.fn(),
      client: fakeClient,
    });

    expect(onMessage.mock.calls[0][0].userName).toBe("UFAIL");
  });
});

describe("SlackAdapter — channel mentions (app_mention)", () => {
  it("strips the bot mention from the text and posts the reply at top level", async () => {
    const onMessage = vi.fn().mockResolvedValue(reply);
    const { init } = makeAdapter(onMessage);
    await init();

    const say = vi.fn();
    await captured.appMention!({
      event: {
        type: "app_mention",
        text: `<@${BOT_USER_ID}> qual è lo stato?`,
        user: "U1",
        channel: "C42",
        ts: "100.0",
      },
      say,
      client: fakeClient,
    });

    expect(onMessage).toHaveBeenCalledOnce();
    const incoming = onMessage.mock.calls[0][0];
    expect(incoming.text).toBe("qual è lo stato?");
    expect(incoming.metadata.conversationIdOverride).toBe("inst-test:slack:C42:100.0");
    expect(incoming.metadata.threadTs).toBe("100.0");
    expect(say).toHaveBeenCalledWith({ text: "pong" });
  });

  it("uses thread_ts for conversationId when the mention is inside a thread", async () => {
    const onMessage = vi.fn().mockResolvedValue(reply);
    const { init } = makeAdapter(onMessage);
    await init();

    await captured.appMention!({
      event: {
        type: "app_mention",
        text: `<@${BOT_USER_ID}> ancora una domanda`,
        user: "U1",
        channel: "C42",
        ts: "200.5",
        thread_ts: "150.0",
      },
      say: vi.fn(),
      client: fakeClient,
    });

    const incoming = onMessage.mock.calls[0][0];
    expect(incoming.metadata.conversationIdOverride).toBe("inst-test:slack:C42:150.0");
    expect(incoming.metadata.threadTs).toBe("150.0");
  });

  it("ignores app_mention events from bots", async () => {
    const onMessage = vi.fn();
    const { init } = makeAdapter(onMessage);
    await init();

    await captured.appMention!({
      event: { type: "app_mention", text: `<@${BOT_USER_ID}> hi`, bot_id: "BOTHER", channel: "C1", ts: "1.0" },
      say: vi.fn(),
      client: fakeClient,
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores mentions with no actual content after stripping the tag", async () => {
    const onMessage = vi.fn();
    const { init } = makeAdapter(onMessage);
    await init();

    await captured.appMention!({
      event: { type: "app_mention", text: `<@${BOT_USER_ID}>   `, user: "U1", channel: "C1", ts: "1.0" },
      say: vi.fn(),
      client: fakeClient,
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("SlackAdapter — outbound mrkdwn conversion on replies", () => {
  const richMarkdown = [
    "## Quarterly summary",
    "",
    "**Revenue**: USD 57,720",
    "- [Open the report](https://example.com/reports/q1)",
  ].join("\n");

  it("converts standard Markdown to Slack mrkdwn before replying to a DM", async () => {
    const onMessage = vi.fn().mockResolvedValue({ text: richMarkdown });
    const { init } = makeAdapter(onMessage);
    await init();

    const say = vi.fn();
    await captured.message!({
      message: { channel_type: "im", text: "report", user: "U1", channel: "D1", ts: "1.0" },
      say,
      client: fakeClient,
    });

    expect(say).toHaveBeenCalledOnce();
    const payload = say.mock.calls[0][0] as { text: string; thread_ts?: string };
    expect(payload.text).toContain("*Quarterly summary*");
    expect(payload.text).toContain("*Revenue*: USD 57,720");
    expect(payload.text).toContain("<https://example.com/reports/q1|Open the report>");
    // No leftover standard-markdown headings or link syntax
    expect(payload.text).not.toMatch(/^##\s/m);
    expect(payload.text).not.toContain("](");
  });

  it("converts standard Markdown to Slack mrkdwn before replying to a channel mention", async () => {
    const onMessage = vi.fn().mockResolvedValue({ text: richMarkdown });
    const { init } = makeAdapter(onMessage);
    await init();

    const say = vi.fn();
    await captured.appMention!({
      event: {
        type: "app_mention",
        text: `<@${BOT_USER_ID}> show me the report`,
        user: "U1",
        channel: "C42",
        ts: "100.0",
      },
      say,
      client: fakeClient,
    });

    expect(say).toHaveBeenCalledOnce();
    const payload = say.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain("*Quarterly summary*");
    expect(payload.text).toContain("<https://example.com/reports/q1|Open the report>");
    expect(payload.text).not.toContain("**");
  });
});
