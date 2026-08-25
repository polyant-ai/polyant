// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFetchMedia } = vi.hoisted(() => ({
  mockFetchMedia: vi.fn(),
}));

vi.mock("./media-fetch.js", () => ({
  fetchMediaFollowingRedirects: mockFetchMedia,
}));

vi.mock("../../audio-transcription.js", () => ({
  transcribeAudio: vi.fn(),
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = adapter.validateSignature("sig", "https://example.com/webhook", {});

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should_log_at_error_for_an_unexpected_internal_throw", async () => {
    mockValidateRequest.mockImplementationOnce(() => {
      throw new Error("unexpected SDK failure");
    });
    const adapter = await initializedAdapter(AUTH_TOKEN_CONFIG);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = adapter.validateSignature("sig", "https://example.com/webhook", {});

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
