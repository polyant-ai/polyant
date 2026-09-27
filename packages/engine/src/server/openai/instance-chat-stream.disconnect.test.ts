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

import { InstanceChatStreamController } from "./instance-chat-stream.controller.js";
import { OpenAIService } from "./openai.service.js";

let pulled = 0;
let release: () => void = () => {};
const chatCompletionStream = vi.fn(async () => {
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
