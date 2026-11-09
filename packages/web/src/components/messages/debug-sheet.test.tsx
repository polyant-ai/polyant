// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Debug sheet: its tabs, the copy action that puts only the open tab's
 * part of the turn on the clipboard, and the turn's request path.
 *
 * The expected JSON is written out by hand rather than built from the
 * component's own export helper: a test that calls the same function the
 * component calls asserts only that it is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import type { MessageDebug, PathModelCall } from "@/lib/api";
import { DebugSheet } from "./debug-sheet";

const messageDebug = vi.fn();
const callExchanges = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    conversations: {
      messageDebug: (...args: unknown[]) => messageDebug(...args),
      callExchanges: (...args: unknown[]) => callExchanges(...args),
    },
  },
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

/** A turn with nothing but what the test sets. */
function turn(data: Partial<MessageDebug>): MessageDebug {
  return { debugPayload: null, steps: null, content: "", turn: null, summary: null, path: null, ...data };
}

function renderSheet(data: Partial<MessageDebug>) {
  messageDebug.mockResolvedValue(turn(data));
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

  it("offers no copy on Model and Tools", async () => {
    renderSheet({ debugPayload: payload, steps: [step] });
    for (const name of [/message\.debug\.usage/, /message\.debug\.tools/]) {
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

  it("says the payload was not captured in the payload tabs", async () => {
    renderSheet({ debugPayload: null, steps: [step] });

    await userEvent.click(screen.getByRole("tab", { name: "message.debug.prompt" }));
    expect(await screen.findByText("message.debug.noPayload")).toBeInTheDocument();
  });
});

describe("DebugSheet request path", () => {
  const T0 = "2026-11-03T14:29:00.000Z";
  const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
  const call = (over: Partial<PathModelCall>): PathModelCall => ({
    id: "call-agent",
    callType: "conversation",
    purpose: null,
    originName: null,
    parentRef: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    startedAt: at(100),
    durationMs: 3000,
    promptTokens: 100,
    completionTokens: 20,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.01,
    stepCount: 2,
    outcome: "ok",
    errorKind: null,
    exchangeCount: 2,
    ...over,
  });
  const steps = [
    {
      index: 0,
      stepType: "initial" as const,
      text: "Checking the order.",
      startedAt: at(100),
      toolCalls: [{ toolCallId: "tc-1", toolName: "lookupOrder", args: { order: "48213" }, startedAt: at(1300), durationMs: 200 }],
      toolResults: [{ toolCallId: "tc-1", result: { status: "shipped" } }],
      finishReason: "tool-calls",
      durationMs: 1200,
    },
    { index: 1, stepType: "tool-result" as const, text: "It ships tomorrow.", startedAt: at(1600), toolCalls: [], finishReason: "stop", durationMs: 1400 },
  ];
  const path: NonNullable<MessageDebug["path"]> = {
    turnStartedAt: T0,
    replySentAt: at(3200),
    deliveredText: "Checking the order.\n\nIt ships tomorrow.",
    intermediateText: null,
    hookRuns: [
      { id: "run-1", name: "classifyIntent", event: "message_received", startedAt: at(10), durationMs: 80, success: true, error: null, args: { text: "hi" }, result: "delivery" },
    ],
    modelCalls: [
      call({}),
      call({ id: "call-hook", callType: "service", purpose: "hook", originName: "classifyIntent", parentRef: "run-1", startedAt: at(20), durationMs: 60, stepCount: 1, exchangeCount: 1 }),
      call({ id: "call-tool", callType: "service", purpose: "tool", originName: "lookupOrder", parentRef: "tc-1", startedAt: at(1350), durationMs: 100, stepCount: 1, exchangeCount: 0 }),
      call({ id: "call-title", callType: "service", purpose: "title", startedAt: at(3300), durationMs: 500, stepCount: 1, exchangeCount: 1 }),
    ],
  };

  beforeEach(() => vi.clearAllMocks());

  it("lays the turn out on its clock, with every run under what made it", async () => {
    renderSheet({ steps, content: "It ships tomorrow.", turn: { channel: "web", streaming: true, speechToText: null }, path });

    expect(await screen.findByText("message.debug.path.title")).toBeInTheDocument();
    expect(screen.getByText("classifyIntent")).toBeInTheDocument();
    expect(screen.getByText("message.debug.path.agent")).toBeInTheDocument();
    expect(screen.getAllByText("message.debug.path.step")).toHaveLength(2);
    expect(screen.getByText("lookupOrder")).toBeInTheDocument();
    // The hook's and the tool's own model calls nest under them.
    expect(screen.getAllByText("message.debug.path.modelCall")).toHaveLength(2);
    expect(screen.getByText(/message\.debug\.path\.system · message\.debug\.path\.purpose\.title/)).toBeInTheDocument();
    // A streamed turn with no policy let the step's text through.
    expect(screen.getByText("«Checking the order.»")).toBeInTheDocument();
    expect(screen.getByText("message.debug.path.fate.unsetStream")).toBeInTheDocument();
    // The send row opens on what the channel received.
    await userEvent.click(screen.getByRole("button", { name: /message\.debug\.path\.sent/ }));
    expect(screen.getByText(/Checking the order\.\s+It ships tomorrow\./)).toBeInTheDocument();
  });

  it("fetches a call's raw exchange only when its row opens", async () => {
    callExchanges.mockResolvedValue({
      exchanges: [{ stepIndex: 0, attempt: 1, status: 200, request: { model: "claude-sonnet-5" }, response: { stop_reason: "end_turn" }, createdAt: at(3800) }],
    });
    renderSheet({ steps, content: "It ships tomorrow.", path });
    await screen.findByText("message.debug.path.title");
    expect(callExchanges).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /message\.debug\.path\.purpose\.title/ }));
    expect(callExchanges).toHaveBeenCalledWith("conv-1", "msg-1", "call-title", "agent-1");
    expect(await screen.findByText("anthropic · claude-sonnet-5")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "message.debug.path.response" }));
    expect(screen.getByText("HTTP 200")).toBeInTheDocument();
  });

  it("says the exchange was not saved when debug was off, without asking for it", async () => {
    renderSheet({ steps, content: "It ships tomorrow.", path });
    await screen.findByText("message.debug.path.title");
    const toolCall = screen.getAllByRole("button", { name: /message\.debug\.path\.modelCall/ }).at(-1)!;
    await userEvent.click(toolCall);
    expect(screen.getByText("message.debug.path.noExchanges")).toBeInTheDocument();
    expect(callExchanges).not.toHaveBeenCalled();
  });

  it("tells an older turn apart and keeps its steps", async () => {
    renderSheet({ steps: [step] });
    expect(await screen.findByText("message.debug.path.legacy")).toBeInTheDocument();
    expect(screen.getByText("lookup")).toBeInTheDocument();
  });
});
