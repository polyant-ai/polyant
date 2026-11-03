// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Delivery to Twilio after a transient failure, against a local stand-in for
 * the Twilio REST API: the real SDK builds the requests and maps the errors,
 * only the host is rewritten.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const fake = vi.hoisted(() => ({ base: "" }));

vi.mock("twilio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("twilio")>();
  const real = actual.default;
  class LocalRequestClient extends real.RequestClient {
    request<T>(opts: Parameters<InstanceType<typeof real.RequestClient>["request"]>[0]) {
      return super.request<T>({ ...opts, uri: opts.uri.replace(/^https:\/\/[^/]+/, fake.base) } as typeof opts);
    }
  }
  const wrapped = Object.assign(
    (user: string, pass: string, options: Record<string, unknown> = {}) =>
      real(user, pass, { ...options, httpClient: new LocalRequestClient() }),
    real,
  );
  return { ...actual, default: wrapped };
});

import { TwilioWhatsAppClient } from "./twilio-client.js";

type Reply = (req: HttpRequest, res: ServerResponse) => void;

const created: Reply = (_req, res) => {
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ sid: "SM1", status: "queued" }));
};
const status = (code: number): Reply => (_req, res) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 20000 + code, message: "fake", status: code }));
};
/** The request reached Twilio, but the connection drops before the answer. */
const dropAfterReceiving: Reply = (req) => req.socket.destroy();

describe("TwilioWhatsAppClient delivery after a transient failure", () => {
  let server: Server;
  let replies: Reply[];
  let bodies: string[];

  beforeEach(async () => {
    replies = [];
    bodies = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push(body);
        (replies.shift() ?? created)(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () =>
    TwilioWhatsAppClient.create({ mode: "authToken", accountSid: "AC" + "0".repeat(32), authToken: "tok" }, "+14155238886");

  it("delivers the reply when Twilio answers 503 first", async () => {
    replies = [status(503)];

    await client().sendMessage("+393331234567", "ciao");

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("Body=ciao");
  });

  it("delivers the reply after a 429", async () => {
    replies = [status(429)];

    await client().sendMessage("+393331234567", "ciao");

    expect(bodies).toHaveLength(2);
  });

  it("delivers every chunk when one in the middle fails transiently", async () => {
    replies = [created, status(500)];

    await client().sendMessage("+393331234567", `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`);

    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain("bbbb");
  });

  it("gives up after a bounded number of attempts", async () => {
    replies = [status(503), status(503), status(503), status(503), status(503)];

    await expect(client().sendMessage("+393331234567", "ciao")).rejects.toMatchObject({ status: 503 });

    expect(bodies).toHaveLength(3);
  });

  it("does not retry a request Twilio refused", async () => {
    replies = [status(400)];

    await expect(client().sendMessage("+393331234567", "ciao")).rejects.toMatchObject({ status: 400 });

    expect(bodies).toHaveLength(1);
  });

  it("does not resend when the connection drops after Twilio received the message", async () => {
    replies = [dropAfterReceiving];

    await expect(client().sendMessage("+393331234567", "ciao")).rejects.toThrow();

    expect(bodies).toHaveLength(1);
  });
});
