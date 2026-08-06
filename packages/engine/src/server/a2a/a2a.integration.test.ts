// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Integration test that drives REAL HTTP requests through the REAL @a2a-js SDK
 * Express middleware (agentCardHandler / jsonRpcHandler) — NOT a mock. This is
 * the only test that can catch the "SDK router matches only '/'" hang: the
 * controller must rewrite req.url to "/" before delegating, or the request
 * never gets a response and the fetch below aborts on the 3s timeout.
 *
 * @nestjs/testing is not a dependency, so instead of Test.createTestingModule we
 * wire the two controller methods into a bare express() app with real req/res
 * (the controller is a thin @Res() bridge — same code path either way).
 *
 * Message/response shapes match the installed @a2a-js/sdk@1.0.0 v1 protobuf JSON
 * form: JSON-RPC method is "SendMessage" (not the legacy "message/send"), a text
 * part is `{ text }`, and the SDK requires the `A2A-Version: 1.0` header.
 */

vi.mock("../../instances/config-resolver.js", () => ({
  resolveInstanceConfig: vi.fn(),
}));
vi.mock("../../instances/store.js", () => ({
  findInstanceBySlug: vi.fn(),
}));

import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { findInstanceBySlug } from "../../instances/store.js";
import { A2aController } from "./a2a.controller.js";
import { A2aHandlerRegistry } from "./a2a-handler.registry.js";
import type { StreamMessageHandler } from "../../channels/types.js";

const FAKE_INSTANCE = { id: "u1", slug: "acme", name: "Acme", description: "d", authEnabled: false };

const fakeStreamHandler: StreamMessageHandler = async () => ({
  textStream: (async function* () {
    yield "Hello";
  })(),
  fullStream: (async function* () {
    yield { type: "text-delta", text: "Hello" };
  })(),
  completed: Promise.resolve({ text: "Hello" }),
});

/** Fetch with a hard timeout so a regressed (hanging) route FAILS FAST, not hangs. */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const registry = new A2aHandlerRegistry();
  registry.setStreamMessageHandler(fakeStreamHandler);
  const controller = new A2aController(registry);

  const app = express();
  app.get("/a2a/:slug/.well-known/agent-card.json", (req, res, next) => {
    controller.agentCard(req.params.slug, req, res).catch(next);
  });
  app.post("/a2a/:slug/jsonrpc", (req, res, next) => {
    controller.jsonrpc(req.params.slug, req, res).catch(next);
  });
  // Map a thrown NotFoundException (a2a disabled) to its HTTP status.
  app.use((err: { getStatus?: () => number; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.getStatus?.() ?? err.status ?? 500).json({ error: "handler error" });
  });

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("A2A HTTP integration (real SDK middleware)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findInstanceBySlug).mockResolvedValue(FAKE_INSTANCE as never);
    // authEnabled:false → the real validateInstanceApiKey is a no-op.
    vi.mocked(resolveInstanceConfig).mockResolvedValue({ a2aEnabled: true, authEnabled: false } as never);
  });

  it("should_serve_the_agent_card_over_a_real_request", async () => {
    const res = await fetchWithTimeout(`${baseUrl}/a2a/acme/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      name: string;
      skills: Array<{ id: string }>;
      supportedInterfaces: Array<{ url: string }>;
    };
    expect(card.name).toBe("Acme");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("conversation");
    expect(card.supportedInterfaces[0].url.endsWith("/a2a/acme/jsonrpc")).toBe(true);
  });

  it("should_complete_a_message_send_task_with_the_reply_text", async () => {
    const res = await fetchWithTimeout(`${baseUrl}/a2a/acme/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "SendMessage",
        params: { message: { messageId: "req-1", role: "ROLE_USER", parts: [{ text: "hi" }] } },
      }),
    });
    expect(res.status).toBe(200);
    const rpc = (await res.json()) as {
      result?: { task?: { status?: { state?: string; message?: { parts?: Array<{ text?: string }> } }; artifacts?: Array<{ parts?: Array<{ text?: string }> }> } };
      error?: unknown;
    };
    expect(rpc.error).toBeUndefined();
    const task = rpc.result?.task;
    expect(task?.status?.state).toBe("TASK_STATE_COMPLETED");
    // The reply text lives in the completed status message and/or the streamed artifact.
    const replyText = [
      ...(task?.status?.message?.parts ?? []),
      ...(task?.artifacts ?? []).flatMap((a) => a.parts ?? []),
    ]
      .map((p) => p.text ?? "")
      .join("");
    expect(replyText).toContain("Hello");
  });

  it("should_404_the_card_when_a2a_disabled", async () => {
    vi.mocked(resolveInstanceConfig).mockResolvedValue({ a2aEnabled: false } as never);
    const res = await fetchWithTimeout(`${baseUrl}/a2a/acme/.well-known/agent-card.json`);
    expect(res.status).toBe(404);
  });
});
