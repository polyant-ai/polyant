// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shutdown must finish even while a client holds a response open. Over real
 * HTTP, because the bug lives in how Node's `server.close()` waits: it stops
 * accepting connections and then waits for every open one, and an SSE stream
 * never ends on its own. `app.close()` hung on it, so nothing after it in the
 * shutdown sequence (audit flush, channel shutdown) ever ran until SIGKILL.
 */

import "reflect-metadata";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Controller, Get, Module, Res, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Response } from "express";
import { closeHttpServer } from "./graceful-close.js";

@Controller()
class HeldController {
  /** Like the activity stream: headers out, then silence, never ends. */
  @Get("held")
  held(@Res() res: Response): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.flushHeaders();
    res.write(": connected\n\n");
  }

  /** Like a chat turn: in flight for a while, then completes. */
  @Get("slow")
  async slow(@Res() res: Response): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    res.json({ done: true });
  }
}

@Module({ controllers: [HeldController] })
class HeldModule {}

let app: INestApplication | undefined;

async function start(): Promise<number> {
  app = await NestFactory.create(HeldModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  return Number(new URL(await app.getUrl()).port);
}

afterEach(async () => {
  app?.getHttpServer().closeAllConnections();
  app = undefined;
});

/** Open a request and resolve once response headers arrive; `ended` settles when the socket closes. */
function open(port: number, path: string) {
  let body = "";
  let resolveEnded: (value: { status: number; body: string }) => void = () => {};
  const ended = new Promise<{ status: number; body: string }>((resolve) => { resolveEnded = resolve; });
  const headers = new Promise<void>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("close", () => resolveEnded({ status: res.statusCode ?? 0, body }));
      resolve();
    });
    req.on("error", () => resolveEnded({ status: 0, body }));
  });
  return { headers, ended };
}

describe("closeHttpServer", () => {
  it("returns within the grace period while a stream is still open, and drops the stream", async () => {
    const port = await start();
    const stream = open(port, "/held");
    await stream.headers;

    const started = Date.now();
    const outcome = await closeHttpServer(app!, 200);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome.forced).toBe(true);
    await expect(stream.ended).resolves.toMatchObject({ status: 200 });
  });

  it("lets a request already in flight finish inside the grace period", async () => {
    const port = await start();
    const turn = open(port, "/slow");
    // Wait until the request has reached the server before shutdown begins.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const outcome = await closeHttpServer(app!, 5_000);

    expect(outcome.forced).toBe(false);
    await expect(turn.ended).resolves.toEqual({ status: 200, body: '{"done":true}' });
  });

  it("returns at once when nothing is connected", async () => {
    await start();
    const started = Date.now();

    const outcome = await closeHttpServer(app!, 5_000);

    expect(outcome.forced).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
