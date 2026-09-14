// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The copy action of the Debug sheet (#179): what reaches the clipboard, and
 * what happens on the turns where part of it is missing.
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
  return screen.findByRole("button", { name: /message\.debug\.copy(All|Empty)/ });
}

describe("DebugSheet copy action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("copies the captured payload and the steps as one JSON object", async () => {
    renderSheet({
      debugPayload: {
        system: "You are a test.",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "lookup", description: "Finds things", parameters: { type: "object" } }],
      },
      steps: [step],
    });

    await userEvent.click(await copyButton());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual({
      system: "You are a test.",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", description: "Finds things", parameters: { type: "object" } }],
      steps: [step],
    });
  });

  it("confirms the copy on the button itself", async () => {
    renderSheet({ debugPayload: null, steps: [step] });
    await userEvent.click(await copyButton());
    expect(await screen.findByText("message.debug.copied")).toBeInTheDocument();
  });

  it("copies the steps alone when the turn was generated with DEBUG off", async () => {
    renderSheet({ debugPayload: null, steps: [step] });
    await userEvent.click(await copyButton());
    // The three payload fields are ABSENT, not empty: a reader must not mistake
    // "not captured" for "the model was sent nothing".
    expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual({ steps: [step] });
  });

  it("disables the action when there is neither a payload nor a step", async () => {
    renderSheet({ debugPayload: null, steps: [] });
    await waitFor(async () => expect(await copyButton()).toBeDisabled());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("says so when the clipboard refuses, instead of looking like it worked", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    renderSheet({ debugPayload: null, steps: [step] });

    await userEvent.click(await copyButton());

    expect(toast.error).toHaveBeenCalledWith("message.debug.copyFailed");
    expect(screen.queryByText("message.debug.copied")).not.toBeInTheDocument();
  });
});
