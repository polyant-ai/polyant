// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A server that only speaks the older `initialize` handshake refuses the
 * protocol probe the client sends first. Once a server has shown that, its
 * next connections skip the probe: one request in series fewer on every
 * reconnect. Runs the real MCP client against a local HTTP server.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectWithTimeout } from "./mcp-connect.js";

/** Requests received, by JSON-RPC method. */
const received = new Map<string, number>();
let failInitialize = false;
let server: http.Server;
let baseUrl: string;

/** A server on the older protocol: no `server/discover`, a session from `initialize`. */
function legacyServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 200 : 405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      received.set(msg.method, (received.get(msg.method) ?? 0) + 1);
      const headers = { "content-type": "application/json", "mcp-session-id": "s1" };
      if (msg.id === undefined) {
        res.writeHead(202, headers).end();
        return;
      }
      if (msg.method === "initialize" && failInitialize) {
        res.writeHead(500).end();
        return;
      }
      const reply =
        msg.method === "server/discover"
          ? { error: { code: -32601, message: "Method not found" } }
          : msg.method === "initialize"
            ? { result: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } } }
            : msg.method === "tools/list"
              ? { result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] } }
              : { result: {} };
      res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }));
    });
  });
}

async function connectOnce(url: string): Promise<string[]> {
  const { client, toolSet } = await connectWithTimeout({ type: "http", url }, 5_000);
  await client.close();
  return Object.keys(toolSet);
}

describe("connectWithTimeout against a server on the older protocol", () => {
  beforeAll(async () => {
    server = legacyServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    received.clear();
    failInitialize = false;
  });

  it("probes the first connection only, then goes straight to initialize", async () => {
    const url = `${baseUrl}/remembered`;

    expect(await connectOnce(url)).toEqual(["echo"]);
    expect(await connectOnce(url)).toEqual(["echo"]);
    expect(await connectOnce(url)).toEqual(["echo"]);

    expect(received.get("server/discover")).toBe(1);
    expect(received.get("initialize")).toBe(3);
  });

  it("probes again after a connection that skipped the probe failed", async () => {
    const url = `${baseUrl}/forgotten`;
    await connectOnce(url);

    failInitialize = true;
    await expect(connectOnce(url)).rejects.toThrow();
    failInitialize = false;
    await connectOnce(url);

    expect(received.get("server/discover")).toBe(2);
  });
});
