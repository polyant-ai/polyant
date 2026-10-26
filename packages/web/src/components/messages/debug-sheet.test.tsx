// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Debug sheet: its tabs, and the copy action that puts only the open tab's
 * part of the turn on the clipboard.
 *
 * The expected JSON is written out by hand rather than built from the
 * component's own export helper: a test that calls the same function the
 * component calls asserts only that it is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import type { MessageDebug } from "@/lib/api";
import { DebugSheet } from "./debug-sheet";

const messageDebug = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { conversations: { messageDebug: (...args: unknown[]) => messageDebug(...args) } },
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const writeText = vi.fn();

const target = { conversationId: "conv-1", messageId: "msg-1", instanceId: "agent-1" };
const step = {
  index: 0,
  stepType: "initial" as const,
  text: "",
  toolCalls: [{ toolCallId: "call-1", toolName: "lookup", args: { q: "x" } }],
  toolResults: [{ toolCallId: "call-1", result: { ok: true } }],
  finishReason: "tool-calls",
  durationMs: 12,
};

function renderSheet(data: MessageDebug) {
  messageDebug.mockResolvedValue(data);
  return render(<DebugSheet open onOpenChange={vi.fn()} target={target} />);
}

function copyButton() {
  return screen.findByRole("button", { name: /common\.copy|message\.debug\.copied/ });
}

const payload = {
  system: "You are a test.",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "lookup", description: "Finds things", parameters: { type: "object" } }],
};

describe("DebugSheet copy action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  async function copyTab(name: RegExp) {
    await userEvent.click(screen.getByRole("tab", { name }));
    // The tab has something to copy only once the turn has loaded.
    await waitFor(async () => expect(await copyButton()).toBeEnabled());
    await userEvent.click(await copyButton());
    return writeText.mock.calls.at(-1)?.[0] as string;
  }

  it("copies the messages sent as the raw JSON array", async () => {
    renderSheet({ debugPayload: payload, steps: [step] });
    expect(JSON.parse(await copyTab(/message\.debug\.messages/))).toEqual([{ role: "user", content: "hi" }]);
  });

  it("copies the system prompt as its text", async () => {
    renderSheet({ debugPayload: payload, steps: [step] });
    expect(await copyTab(/message\.debug\.prompt/)).toBe("You are a test.");
  });

  it("copies the conversation state as raw JSON", async () => {
    const withState = {
      ...payload,
      messages: [{ role: "user", content: `hi\n<context>\n<conversation_state>{"booking":{"day":"monday"}}</conversation_state>\n</context>` }],
    };
    renderSheet({ debugPayload: withState, steps: [step] });
    expect(JSON.parse(await copyTab(/message\.debug\.context/))).toEqual({ booking: { day: "monday" } });
  });

  it("offers no copy on Model, Tools and Steps", async () => {
    renderSheet({ debugPayload: payload, steps: [step] });
    for (const name of [/message\.debug\.usage/, /message\.debug\.tools/, /message\.debug\.steps/]) {
      await userEvent.click(screen.getByRole("tab", { name }));
      expect(screen.queryByRole("button", { name: /common\.copy/ })).not.toBeInTheDocument();
    }
  });

  it("confirms the copy on the button itself", async () => {
    renderSheet({ debugPayload: payload, steps: [step] });
    await copyTab(/message\.debug\.messages/);
    expect(await screen.findByText("message.debug.copied")).toBeInTheDocument();
  });

  it("disables the action when the payload was not captured", async () => {
    renderSheet({ debugPayload: null, steps: [step] });
    await userEvent.click(screen.getByRole("tab", { name: /message\.debug\.messages/ }));
    expect(await screen.findByText("message.debug.noPayload")).toBeInTheDocument();
    expect(await copyButton()).toBeDisabled();
  });

  it("says so when the clipboard refuses, instead of looking like it worked", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    renderSheet({ debugPayload: payload, steps: [step] });

    await copyTab(/message\.debug\.messages/);

    expect(toast.error).toHaveBeenCalledWith("message.debug.copyFailed");
    expect(screen.queryByText("message.debug.copied")).not.toBeInTheDocument();
  });
});

describe("DebugSheet tabs", () => {
  const stateMessage = {
    role: "user",
    content: `hi\n<context>\n<conversation_state>{"booking":{"day":"monday"}}</conversation_state>\n</context>`,
  };

  it("opens on Usage and shows the turn's state as a closed tree in Context", async () => {
    renderSheet({
      debugPayload: { system: "You are a test.", messages: [stateMessage], tools: [] },
      steps: [step],
    });

    expect(screen.getByRole("tab", { name: "message.debug.usage" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("tab", { name: "message.debug.context" }));
    const branch = await screen.findByRole("button", { name: "booking" });
    expect(branch).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(branch);
    expect(screen.getByText('"monday"')).toBeInTheDocument();
  });

  it("shows how the turn arrived and its model calls in Model", async () => {
    renderSheet({
      debugPayload: null,
      steps: [],
      turn: { channel: "whatsapp", streaming: false, speechToText: { provider: "deepgram", durationMs: 320, audioDurationSec: 4.5 } },
      modelCalls: [
        { callType: "conversation", provider: "openai", model: "gpt-4o", durationMs: 900,
          promptTokens: 10, completionTokens: 5, costUsd: 0.001, outcome: "ok", errorKind: null, createdAt: null },
        { callType: "service", provider: "openai", model: "gpt-4o-mini", durationMs: 50,
          promptTokens: 3, completionTokens: 0, costUsd: 0, outcome: "error", errorKind: "rate_limit", createdAt: null },
      ],
    });

    expect(await screen.findByText("whatsapp")).toBeInTheDocument();
    expect(screen.getByText("deepgram")).toBeInTheDocument();
    expect(screen.getByText("message.debug.modelCalls")).toBeInTheDocument();
    expect(screen.getByText("message.debug.callConversation")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "message.debug.outcomeOk" })).toHaveTextContent("✅");
    expect(screen.getByRole("img", { name: "message.debug.outcomeError" })).toHaveTextContent("❌");
    expect(screen.getByText("rate_limit")).toBeInTheDocument();
  });

  it("keeps the system prompt in Prompt and the messages sent in Messages", async () => {
    renderSheet({
      debugPayload: { system: "You are a test.", messages: [stateMessage], tools: [] },
      steps: [step],
    });

    await userEvent.click(screen.getByRole("tab", { name: "message.debug.prompt" }));
    expect(await screen.findByText("You are a test.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "0" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /message\.debug\.messages/ }));
    expect(await screen.findByRole("button", { name: "0" })).toHaveAttribute("aria-expanded", "false");
  });

  it("says the payload was not captured in the payload tabs, and keeps the steps", async () => {
    renderSheet({ debugPayload: null, steps: [step] });

    await userEvent.click(screen.getByRole("tab", { name: "message.debug.prompt" }));
    expect(await screen.findByText("message.debug.noPayload")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /message\.debug\.steps/ }));
    expect(await screen.findByText("lookup")).toBeInTheDocument();
  });
});
