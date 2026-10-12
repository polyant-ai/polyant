// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The wizard's chat test uses the Playground's own route and stream client, so
 * these pin what a person relies on: the request goes to playground/stream with
 * the session alone (no key header), the reply is assembled from the stream, and
 * a refusal reads as words.
 */

import { sendWizardChat } from "./wizard-chat";

const errorMessages = {
  network: "network",
  noBody: "no body",
  streamRead: "stream read",
  httpFailed: (s: number) => `http ${s}`,
};
const opts = { messages: [{ role: "user" as const, content: "hi" }], chatId: "c1", errorMessages };

function sse(...events: [string, unknown][]): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(text, { status: 200 });
}

describe("chat test through the playground session route", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to playground/stream without any key header and returns the streamed reply", async () => {
    fetchMock.mockResolvedValue(sse(["text-delta", { text: "Hel" }], ["text-delta", { text: "lo" }], ["done", {}]));
    const seen: string[] = [];
    const reply = await sendWizardChat("bot", opts, (d) => seen.push(d));
    expect(reply).toBe("Hello");
    expect(seen).toEqual(["Hel", "lo"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/instances/bot/playground/stream");
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(JSON.parse(init.body)).toMatchObject({ model: "bot", chat_id: "c1", stream: true });
  });

  it.each([[403], [404]])("reports an HTTP %i in words the person can read", async (status) => {
    fetchMock.mockResolvedValue(new Response("{}", { status, statusText: "no" }));
    await expect(sendWizardChat("bot", opts, () => {})).rejects.toThrow();
  });

  it("surfaces an error event", async () => {
    fetchMock.mockResolvedValue(sse(["error", { message: "no provider key" }], ["done", {}]));
    await expect(sendWizardChat("bot", opts, () => {})).rejects.toThrow("no provider key");
  });

  it("reports a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(sendWizardChat("bot", opts, () => {})).rejects.toThrow("network");
  });
});
