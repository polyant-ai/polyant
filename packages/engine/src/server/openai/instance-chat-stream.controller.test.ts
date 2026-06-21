// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for InstanceChatStreamController — the native typed-SSE endpoint
 * used by the admin playground (POST /api/agents/:slug/chat/stream).
 *
 * Covers:
 * - AI SDK v6 `fullStream` parts → typed SSE event mapping
 * - terminal `done` event
 * - per-instance API key auth delegation (401 propagation)
 */

const { mockValidateInstanceApiKey } = vi.hoisted(() => ({
  mockValidateInstanceApiKey: vi.fn(),
}));

vi.mock("./instance-api-key-auth.js", () => ({
  validateInstanceApiKey: mockValidateInstanceApiKey,
}));

vi.mock("./openai.service.js", () => ({
  OpenAIService: vi.fn(),
}));

import { InstanceChatStreamController } from "./instance-chat-stream.controller.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeRes {
  headers: Record<string, string>;
  writes: string[];
  ended: boolean;
  setHeader(k: string, v: string): void;
  write(chunk: string): boolean;
  end(): void;
}

function makeRes(): FakeRes {
  return {
    headers: {},
    writes: [],
    ended: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(chunk) {
      this.writes.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

function makeReq(authHeader?: string) {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    on: vi.fn(),
  };
}

/** Parse the accumulated `event:`/`data:` SSE writes into structured events. */
function parseEvents(res: FakeRes): { event: string; data: unknown }[] {
  const joined = res.writes.join("");
  return joined
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((block) => {
      let event = "message";
      let dataLine = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine += line.slice(6);
      }
      return { event, data: JSON.parse(dataLine) };
    });
}

function makeStream(events: Record<string, unknown>[]) {
  return {
    textStream: (async function* () {})(),
    fullStream: (async function* () {
      for (const e of events) yield e;
    })(),
    completed: Promise.resolve({ text: "ok" }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InstanceChatStreamController.stream", () => {
  let controller: InstanceChatStreamController;
  let chatCompletionStream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateInstanceApiKey.mockResolvedValue(undefined);
    chatCompletionStream = vi.fn();
    controller = new InstanceChatStreamController({ chatCompletionStream } as never);
  });

  it("maps v6 fullStream parts to typed SSE events and emits done", async () => {
    chatCompletionStream.mockResolvedValue(
      makeStream([
        { type: "start-step" },
        { type: "reasoning-delta", text: "thinking" },
        { type: "tool-call", toolCallId: "tc1", toolName: "search", input: { q: "x" } },
        { type: "tool-result", toolCallId: "tc1", output: { hits: 2 } },
        { type: "text-delta", text: "Hello" },
        { type: "finish-step", finishReason: "stop" },
      ]),
    );

    const res = makeRes();
    await controller.stream("acme", { model: "ignored", messages: [] } as never, makeReq() as never, res as never);

    const events = parseEvents(res);
    const byEvent = (name: string) => events.filter((e) => e.event === name);

    expect(byEvent("step-start")[0].data).toEqual({ index: 0, stepType: "initial" });
    expect(byEvent("reasoning-delta")[0].data).toEqual({ text: "thinking" });
    expect(byEvent("tool-call")[0].data).toEqual({ id: "tc1", name: "search", args: { q: "x" } });
    expect(byEvent("tool-result")[0].data).toEqual({ id: "tc1", result: { hits: 2 } });
    expect(byEvent("text-delta")[0].data).toEqual({ text: "Hello" });
    expect(byEvent("step-finish")[0].data).toEqual({ index: 0, finishReason: "stop" });
    expect(events.at(-1)?.event).toBe("done");
    expect(res.ended).toBe(true);
  });

  it("forces the model field to the URL slug", async () => {
    chatCompletionStream.mockResolvedValue(makeStream([]));
    const res = makeRes();
    await controller.stream("acme", { model: "evil-override", messages: [], stream: false } as never, makeReq() as never, res as never);

    expect(chatCompletionStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "acme", stream: true }),
    );
  });

  it("propagates auth failure before opening the stream", async () => {
    const { UnauthorizedException } = await import("@nestjs/common");
    mockValidateInstanceApiKey.mockRejectedValue(new UnauthorizedException("Invalid API key"));
    const res = makeRes();

    await expect(
      controller.stream("acme", { model: "acme", messages: [] } as never, makeReq("Bearer bad") as never, res as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(chatCompletionStream).not.toHaveBeenCalled();
  });

  it("emits an error event then done when stream initialisation fails", async () => {
    chatCompletionStream.mockRejectedValue(new Error("boom"));
    const res = makeRes();

    await controller.stream("acme", { model: "acme", messages: [] } as never, makeReq() as never, res as never);

    const events = parseEvents(res);
    expect(events.find((e) => e.event === "error")?.data).toEqual({ message: "boom" });
    expect(events.at(-1)?.event).toBe("done");
    expect(res.ended).toBe(true);
  });
});
