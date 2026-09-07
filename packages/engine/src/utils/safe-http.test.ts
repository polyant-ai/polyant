// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { safeFetch } from "./safe-http.js";

/**
 * These tests deliberately do NOT mock undici.
 *
 * The undici 8 upgrade broke the SSRF path in a way no mocked test could see:
 * an Agent from the npm undici passed as `dispatcher` to Node's *global* fetch
 * fails with `invalid onRequestStart method`, because Node 22 bundles undici
 * 6.21.2 and undici 8 removed the legacy handler wrappers. The existing tool
 * tests call `vi.mock("undici", ...)`, so they stayed green through a total
 * breakage of DNS pinning. Hence: real server, real socket, real undici.
 */

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`pinned-ok:${req.headers.host}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("safeFetch", () => {
  it("connects to the pinned address for a hostname that does not resolve", async () => {
    // The hostname is in the reserved .invalid TLD, so it can never resolve.
    // The request can therefore only succeed if the pinned lookup is applied —
    // which makes a false positive impossible.
    const response = await safeFetch(
      new URL(`http://pinned-target.invalid:${port}/`),
      { signal: AbortSignal.timeout(8000) },
      { resolve: async () => ({ address: "127.0.0.1", family: 4 }) },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(`pinned-ok:pinned-target.invalid:${port}`);
  });

  it("refuses a private address before opening any socket", async () => {
    await expect(
      safeFetch(new URL("http://10.0.0.1/"), { signal: AbortSignal.timeout(8000) }),
    ).rejects.toThrow(/^Blocked: private\/reserved IP/);
  });
});
