// SPDX-License-Identifier: AGPL-3.0-or-later

const stream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { instances: { webChatStream: stream } } }));

import { sendWizardChat } from "./wizard-chat";

const errors = { network: "network", http: (s: number) => `http ${s}` };
const opts = { messages: [{ role: "user" as const, content: "hi" }], chatId: "c1", agentKey: "k-123", errors };

function sse(...events: [string, unknown][]): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(text, { status: 200 });
}

describe("chat test through the Web channel", () => {
  beforeEach(() => {
    stream.mockReset();
  });

  it("sends the agent key and returns the streamed reply", async () => {
    stream.mockResolvedValue(sse(["text-delta", { text: "Hel" }], ["text-delta", { text: "lo" }], ["done", {}]));
    const seen: string[] = [];
    const reply = await sendWizardChat("bot", opts, { onText: (d) => seen.push(d) });
    expect(reply).toBe("Hello");
    expect(seen).toEqual(["Hel", "lo"]);
    expect(stream).toHaveBeenCalledWith("bot", { messages: opts.messages, chatId: "c1" }, expect.objectContaining({ agentKey: "k-123" }));
  });

  it.each([[401], [404]])("reports an HTTP %i in words the person can read", async (status) => {
    stream.mockResolvedValue(new Response("{}", { status }));
    await expect(sendWizardChat("bot", opts, { onText: () => {} })).rejects.toThrow(`http ${status}`);
  });

  it("surfaces an error event when no reply arrived", async () => {
    stream.mockResolvedValue(sse(["error", { message: "no provider key" }], ["done", {}]));
    await expect(sendWizardChat("bot", opts, { onText: () => {} })).rejects.toThrow("no provider key");
  });

  it("reports a network failure", async () => {
    stream.mockRejectedValue(new TypeError("offline"));
    await expect(sendWizardChat("bot", opts, { onText: () => {} })).rejects.toThrow("network");
  });
});
