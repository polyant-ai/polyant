// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `POST /api/instances/:slug/chat/stream` stops relaying when the client goes
 * away — over real HTTP, because which Node event fires when is the point. The
 * request's `close` fires once the JSON body parser has read the body, before
 * the handler runs; a listener on it never saw a real disconnect, so the relay
 * kept pulling the turn's parts and writing them into a closed socket.
 */

import "reflect-metadata";
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

vi.mock("./instance-api-key-auth.js", () => ({ validateInstanceApiKey: vi.fn(async () => undefined) }));
// The real service opens the database; the controller only needs its token.
vi.mock("./openai.service.js", () => ({ OpenAIService: class OpenAIService {} }));
// The tracing wrapper, minus the tracing: the real AI SDK `streamText` underneath.
vi.mock("../../ai-gateway/langsmith.js", async () => {
  const ai = await import("ai");
  return { tracedGenerateText: ai.generateText, tracedStreamText: ai.streamText };
});

import { MockLanguageModelV4 } from "ai/test";
import { InstanceChatStreamController } from "./instance-chat-stream.controller.js";
import { OpenAIService } from "./openai.service.js";
import { createProvider } from "../../ai-gateway/providers/base.js";

let pulled = 0;
let release: () => void = () => {};
const chatCompletionStream = vi.fn(async (_request?: unknown, _signal?: AbortSignal) => {
  const held = new Promise<void>((resolve) => { release = resolve; });
  return {
    textStream: (async function* () {})(),
    fullStream: (async function* () {
      pulled++;
      yield { type: "text-delta", text: "uno" };
      await held;
      pulled++;
      yield { type: "text-delta", text: "due" };
      pulled++;
      yield { type: "text-delta", text: "tre" };
    })(),
    completed: Promise.resolve({ text: "uno due tre" }),
  };
});

@Module({
  controllers: [InstanceChatStreamController],
  providers: [{ provide: OpenAIService, useValue: { chatCompletionStream } }],
})
class StreamTestModule {}

let app: INestApplication;
let port: number;

beforeAll(async () => {
  app = await NestFactory.create(StreamTestModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  port = Number(new URL(await app.getUrl()).port);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  pulled = 0;
});

function post(): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/instances/demo/chat/stream",
      headers: { "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.on("response", (res) => resolve({ req, res }));
    req.end(JSON.stringify({ messages: [{ role: "user", content: "ciao" }] }));
  });
}

describe("chat/stream client disconnect", () => {
  it("relays the whole turn to a client that stays connected", async () => {
    const { res } = await post();
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
      if (body.includes("uno")) release();
    });
    await new Promise((resolve) => res.on("end", resolve));

    expect(body).toContain("tre");
    expect(body).toContain("event: done");
  });

  it("stops pulling the turn once the client has gone", async () => {
    const { req, res } = await post();
    await new Promise<void>((resolve) => res.once("data", () => resolve()));

    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 50));

    expect(pulled).toBeLessThan(3);
  });
});

describe("chat/stream client disconnect after output", () => {
  it("still completes and persists the turn", async () => {
    // Once the turn has produced text a disconnect only stops the relay; the
    // turn runs to its end and is saved. The relay stops pulling `fullStream`,
    // so what finishes the model call is the provider's own `await result.text`
    // in ai-gateway/providers/base.ts consuming the rest. This drives the real
    // AI SDK stream through that path.
    let resume: () => void = () => {};
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "uno " });
            await resumed;
            controller.enqueue({ type: "text-delta", id: "t", delta: "due " });
            controller.enqueue({ type: "text-delta", id: "t", delta: "tre" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 3, text: 3, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      }),
    });

    const persisted: string[] = [];
    let signal: AbortSignal | undefined;
    chatCompletionStream.mockImplementationOnce(async (_request?: unknown, abort?: AbortSignal) => {
      signal = abort;
      const turn = await createProvider("test", () => model as never).chatStream!(
        { tier: "standard", messages: [{ role: "user", content: "ciao" }], abortSignal: abort },
        "mock",
      );
      return {
        textStream: turn.textStream,
        fullStream: turn.fullStream,
        // What the pipeline does with the finished turn: commit it.
        completed: turn.response.then((response) => {
          persisted.push(response.text);
          return { text: response.text };
        }),
      } as never;
    });

    const { req, res } = await post();
    await new Promise<void>((resolve) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        if (body.includes("uno")) resolve();
      });
    });
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    resume();

    await vi.waitFor(() => expect(persisted).toEqual(["uno due tre"]));
    expect(signal?.aborted).toBe(false);
  });
});
