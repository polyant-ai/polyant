// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The inbound turn: its reply must survive an adapter restart (a channel save
 * shuts the adapter down while a turn is in flight), and a file download must
 * stay bounded in time and size.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asInstanceSlug } from "../../../instances/identifiers.js";
import type { IncomingMessage, OutgoingMessage } from "../../types.js";

const { handlers, sendMessage, getFile } = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
  sendMessage: vi.fn(),
  getFile: vi.fn(),
}));
vi.mock("grammy", () => ({
  Bot: class {
    api = { sendMessage, getFile, setWebhook: vi.fn(async () => true) };
    init = vi.fn(async () => undefined);
    on = (filter: string, fn: (ctx: unknown) => Promise<void>) => void handlers.set(filter, fn);
  },
}));

import { FILE_DOWNLOAD_MAX_BYTES, TelegramAdapter, readBodyCapped } from "./index.js";

function textCtx(text: string) {
  return {
    from: { id: 7, first_name: "Ada" },
    chat: { id: 42, type: "private" },
    message: { message_id: 1, text },
    reply: vi.fn(),
  };
}

describe("Telegram inbound turn", () => {
  beforeEach(() => {
    handlers.clear();
    sendMessage.mockReset().mockResolvedValue({});
    getFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the reply of a turn that was in flight when the adapter shut down", async () => {
    let finishTurn!: (reply: OutgoingMessage) => void;
    const onMessage = vi.fn(
      (_msg: IncomingMessage) => new Promise<OutgoingMessage>((resolve) => (finishTurn = resolve)),
    );
    const adapter = new TelegramAdapter(asInstanceSlug("shop"), { botToken: "fixture" }, "https://engine.test/x");
    await adapter.initialize(onMessage);

    const turn = handlers.get("message:text")!(textCtx("hello"));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    await adapter.shutdown(); // a channel save restarts the adapter mid-turn
    finishTurn({ text: "hi there" });
    await turn;

    expect(sendMessage).toHaveBeenCalledWith("42", expect.stringContaining("hi there"), expect.anything());
  });

  it("does not download a file Telegram reports as over the cap", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    getFile.mockResolvedValue({ file_path: "docs/big.pdf", file_size: FILE_DOWNLOAD_MAX_BYTES + 1 });
    const onMessage = vi.fn(async (_msg: IncomingMessage): Promise<OutgoingMessage> => ({ text: "" }));
    const adapter = new TelegramAdapter(asInstanceSlug("shop"), { botToken: "fixture" }, "https://engine.test/x");
    await adapter.initialize(onMessage);

    await handlers.get("message:document")!({
      ...textCtx(""),
      message: { message_id: 2, caption: "see attached", document: { file_id: "f1", mime_type: "application/pdf" } },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onMessage.mock.calls[0]![0]).toMatchObject({ text: "see attached", attachments: undefined });
  });

  it("downloads with a deadline", async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchSpy);
    getFile.mockResolvedValue({ file_path: "docs/small.pdf", file_size: 3 });
    const onMessage = vi.fn(async (_msg: IncomingMessage): Promise<OutgoingMessage> => ({ text: "" }));
    const adapter = new TelegramAdapter(asInstanceSlug("shop"), { botToken: "fixture" }, "https://engine.test/x");
    await adapter.initialize(onMessage);

    await handlers.get("message:document")!({
      ...textCtx(""),
      message: { message_id: 3, document: { file_id: "f2", mime_type: "application/pdf", file_name: "a.pdf" } },
    });

    expect((fetchSpy.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(onMessage.mock.calls[0]?.[0].attachments?.[0]?.data).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe("readBodyCapped", () => {
  it("refuses a body whose declared length is over the cap", async () => {
    const res = new Response("0123456789", { headers: { "content-length": "10" } });
    expect(await readBodyCapped(res, 5)).toBeUndefined();
  });

  it("stops reading a body without a declared length once it passes the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4)); // never ends on its own
      },
    });
    expect(await readBodyCapped(new Response(stream), 10)).toBeUndefined();
  });

  it("returns a body under the cap", async () => {
    expect(await readBodyCapped(new Response("abc"), 5)).toEqual(Buffer.from("abc"));
  });
});
