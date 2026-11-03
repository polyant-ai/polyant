// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const { mockFetchMedia } = vi.hoisted(() => ({
  mockFetchMedia: vi.fn(),
}));

vi.mock("./media-fetch.js", () => ({
  fetchMediaFollowingRedirects: mockFetchMedia,
}));

vi.mock("../../audio-transcription.js", () => ({
  transcribeInbound: vi.fn(),
}));

const { mockCreate, mockValidateRequest } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ sid: "SM123" }),
  mockValidateRequest: vi.fn().mockReturnValue(true),
}));

vi.mock("twilio", () => {
  const client = { messages: { create: mockCreate } };
  const Twilio = vi.fn(() => client);
  (Twilio as any).validateRequest = mockValidateRequest;
  return { default: Twilio, Twilio };
});

import { WhatsAppAdapter } from "./index.js";
import { asInstanceSlug } from "../../../instances/identifiers.js";
import type { WhatsAppConfig } from "./resolve-credentials.js";
import { COLORS } from "../../../utils/create-logger.js";

const INSTANCE_SLUG = asInstanceSlug("test-instance");

const AUTH_TOKEN_CONFIG: WhatsAppConfig = {
  accountSid: "AC00000000000000000000000000000001",
  authToken: "token123",
  whatsappNumber: "+14155238886",
};

const API_KEY_CONFIG: WhatsAppConfig = {
  authMode: "apiKey",
  accountSid: "AC00000000000000000000000000000001",
  apiKeySid: "SK00000000000000000000000000000002",
  apiKeySecret: "secret-value",
  whatsappNumber: "+14155238886",
};

function emptyMediaResponse(): Response {
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
}

async function initializedAdapter(cfg: WhatsAppConfig): Promise<WhatsAppAdapter> {
  const adapter = new WhatsAppAdapter(INSTANCE_SLUG, cfg);
  await adapter.initialize(vi.fn().mockResolvedValue({ text: "ok" }));
  return adapter;
}

describe("WhatsAppAdapter media download Basic-auth contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchMedia.mockResolvedValue(emptyMediaResponse());
  });

  // Pins the cross-module contract: `basicAuthValue()` returns BARE base64
  // and `fetchMediaFollowingRedirects` (media-fetch.ts) prefixes `Basic ` itself.
  // If `basicAuthValue()` ever starts including the prefix, this test must fail —
  // otherwise a double "Basic Basic ..." header 401s and downloadMedia silently
  // swallows it, dropping the attachment with no visible error.
  it("should_pass_bare_base64_of_accountSid_authToken_in_authToken_mode", async () => {
    const adapter = await initializedAdapter(AUTH_TOKEN_CONFIG);

    await adapter.handleInbound({
      from: "whatsapp:+393331234567",
      body: "",
      messageSid: "SM123",
      instanceId: INSTANCE_SLUG,
      media: [{ url: "https://api.twilio.com/media/ME1", contentType: "image/jpeg" }],
    });

    expect(mockFetchMedia).toHaveBeenCalledTimes(1);
    const [, basicAuth] = mockFetchMedia.mock.calls[0] as [string, string];
    const expected = Buffer.from("AC00000000000000000000000000000001:token123").toString("base64");
    expect(basicAuth).toBe(expected);
    expect(basicAuth.startsWith("Basic ")).toBe(false);
  });

  it("should_pass_bare_base64_of_apiKeySid_apiKeySecret_in_apiKey_mode", async () => {
    const adapter = await initializedAdapter(API_KEY_CONFIG);

    await adapter.handleInbound({
      from: "whatsapp:+393331234567",
      body: "",
      messageSid: "SM124",
      instanceId: INSTANCE_SLUG,
      media: [{ url: "https://api.twilio.com/media/ME2", contentType: "image/jpeg" }],
    });

    expect(mockFetchMedia).toHaveBeenCalledTimes(1);
    const [, basicAuth] = mockFetchMedia.mock.calls[0] as [string, string];
    const expected = Buffer.from(
      "SK00000000000000000000000000000002:secret-value",
    ).toString("base64");
    expect(basicAuth).toBe(expected);
    expect(basicAuth.startsWith("Basic ")).toBe(false);
  });
});

describe("WhatsAppAdapter.validateSignature error observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should_log_at_warn_and_not_error_for_the_expected_wrong_mode_case", async () => {
    const adapter = await initializedAdapter(API_KEY_CONFIG);
    // The logger writes warn and error lines to stderr; the level shows in the colour.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = adapter.validateSignature("sig", "https://example.com/webhook", {});

    expect(result).toBe(false);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toContain(COLORS.yellow);
    stderr.mockRestore();
  });

  it("should_log_at_error_for_an_unexpected_internal_throw", async () => {
    mockValidateRequest.mockImplementationOnce(() => {
      throw new Error("unexpected SDK failure");
    });
    const adapter = await initializedAdapter(AUTH_TOKEN_CONFIG);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = adapter.validateSignature("sig", "https://example.com/webhook", {});

    expect(result).toBe(false);
    expect(stderr).toHaveBeenCalled(); // debug level adds stack lines after the message line
    expect(String(stderr.mock.calls[0]![0])).toContain(COLORS.red);
    stderr.mockRestore();
  });
});

describe("WhatsAppAdapter media download size cap", () => {
  const MB = 1024 * 1024;
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** A media host that streams `totalBytes` with no Content-Length, counting what it managed to write. */
  async function streamingMediaHost(totalBytes: number): Promise<{ url: string; written: () => number }> {
    let written = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      const chunk = Buffer.alloc(MB);
      const pump = (): void => {
        while (written < totalBytes) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      res.on("close", () => res.removeAllListeners("drain"));
      pump();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/media`, written: () => written };
  }

  it("drops an attachment whose body grows past the cap instead of buffering all of it", async () => {
    const host = await streamingMediaHost(64 * MB);
    mockFetchMedia.mockImplementation(() => fetch(host.url));
    const onMessage = vi.fn().mockResolvedValue({ text: "" });
    const adapter = new WhatsAppAdapter(INSTANCE_SLUG, AUTH_TOKEN_CONFIG);
    await adapter.initialize(onMessage);

    await adapter.handleInbound({
      from: "whatsapp:+393331234567",
      body: "see attached",
      messageSid: "SM900",
      instanceId: INSTANCE_SLUG,
      media: [{ url: "https://api.twilio.com/media/ME9", contentType: "application/pdf" }],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    // Compare a count, never the Buffer: a failure must not pretty-print 64 MB.
    expect(onMessage.mock.calls[0]![0].attachments?.length ?? 0).toBe(0);
    expect(onMessage.mock.calls[0]![0].text).toBe("see attached");
    expect(host.written()).toBeLessThan(40 * MB);
  });

  it("keeps an attachment under the cap", async () => {
    const host = await streamingMediaHost(2 * MB);
    mockFetchMedia.mockImplementation(() => fetch(host.url));
    const onMessage = vi.fn().mockResolvedValue({ text: "" });
    const adapter = new WhatsAppAdapter(INSTANCE_SLUG, AUTH_TOKEN_CONFIG);
    await adapter.initialize(onMessage);

    await adapter.handleInbound({
      from: "whatsapp:+393331234567",
      body: "",
      messageSid: "SM901",
      instanceId: INSTANCE_SLUG,
      media: [{ url: "https://api.twilio.com/media/ME10", contentType: "application/pdf" }],
    });

    const attachments = onMessage.mock.calls[0]![0].attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].data.length).toBe(2 * MB);
  });
});
