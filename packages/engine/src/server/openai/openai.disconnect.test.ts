// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `POST /v1/chat/completions` with `stream: true` treats a client that hangs
 * up like chat/stream does, over real HTTP. It used to ignore the disconnect:
 * a turn nobody was reading ran and was paid for in full, and the relay kept
 * writing into a closed socket.
 */

import "reflect-metadata";
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

vi.mock("./instance-api-key-auth.js", () => ({ validateInstanceApiKey: vi.fn(async () => undefined) }));
vi.mock("./openai.service.js", () => ({ OpenAIService: class OpenAIService {} }));

import { OpenAIController } from "./openai.controller.js";
import { OpenAIService } from "./openai.service.js";

let pulled = 0;
let release: () => void = () => {};
let signal: AbortSignal | undefined;
let firstPart: { type: string; text?: string; toolName?: string } = { type: "text-delta", text: "uno" };

const chatCompletionStream = vi.fn(async (_request: unknown, abort?: AbortSignal) => {
  signal = abort;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return {
    textStream: (async function* () {})(),
    fullStream: (async function* () {
      pulled++;
      yield firstPart;
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
  controllers: [OpenAIController],
  providers: [{ provide: OpenAIService, useValue: { chatCompletionStream } }],
})
class CompletionsTestModule {}

let app: INestApplication;
let port: number;

beforeAll(async () => {
  app = await NestFactory.create(CompletionsTestModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  port = Number(new URL(await app.getUrl()).port);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  pulled = 0;
  signal = undefined;
  firstPart = { type: "text-delta", text: "uno" };
});

function post(): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.on("response", (res) => resolve({ req, res }));
    req.end(JSON.stringify({ model: "demo", stream: true, messages: [{ role: "user", content: "ciao" }] }));
  });
}

describe("/v1/chat/completions client disconnect", () => {
  it("relays the whole turn to a client that stays connected", async () => {
    const { res } = await post();
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
      if (body.includes("uno")) release();
    });
    await new Promise((resolve) => res.on("end", resolve));

    expect(body).toContain("tre");
    expect(body).toContain("data: [DONE]");
    expect(signal?.aborted).toBe(false);
  });

  it("stops pulling the turn once the client has gone, and lets a turn with output finish", async () => {
    const { req, res } = await post();
    await new Promise<void>((resolve) => res.on("data", (chunk) => { if (String(chunk).includes("uno")) resolve(); }));

    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 50));

    expect(pulled).toBeLessThan(3);
    expect(signal?.aborted).toBe(false);
  });

  it("aborts the turn when the client goes before it produced anything", async () => {
    // A part that is not output: the turn has written nothing yet.
    firstPart = { type: "start-step" };
    const { req, res } = await post();
    await new Promise<void>((resolve) => res.once("data", () => resolve()));

    req.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    release();
  });
});
