// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockGetChannelConfig, mockResolveInstanceId, mockChannelManager } = vi.hoisted(() => ({
  mockGetChannelConfig: vi.fn(),
  mockResolveInstanceId: vi.fn(),
  mockChannelManager: {
    adapters: new Map(),
  },
}));

vi.mock("../../instances/channels.store.js", () => ({
  getChannelConfig: mockGetChannelConfig,
  // Keep in sync with the real tuple in instances/channels.store.ts —
  // any new API-configurable channel type must be added here.
  CHANNEL_TYPES: ["telegram", "slack", "whatsapp", "agent"],
  resolveWhatsAppAuthMode: (cfg: Record<string, unknown>) =>
    cfg.authMode === "apiKey" ? "apiKey" : "authToken",
}));

vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: mockResolveInstanceId,
}));

vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: mockChannelManager,
}));

import {
  TwilioWebhookController,
  WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE,
  collectSignedParams,
} from "./twilio-webhook.controller.js";

/** Create a minimal Express-like Request mock for the controller */
function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    protocol: "https",
    headers: { host: "example.ngrok-free.dev" },
    get: (name: string) => name === "host" ? "example.ngrok-free.dev" : undefined,
    originalUrl: "/webhooks/twilio/test-instance/whatsapp",
    ...overrides,
  };
}

describe("TwilioWebhookController", () => {
  let controller: TwilioWebhookController;

  const validBody = {
    MessageSid: "SM123",
    From: "whatsapp:+393331234567",
    To: "whatsapp:+14155238886",
    Body: "Hello agent",
    ProfileName: "Paolo",
  };

  const mockAdapter = {
    name: "whatsapp",
    handleInbound: vi.fn().mockResolvedValue("response text"),
    validateSignature: vi.fn().mockReturnValue(true),
    initialize: vi.fn(),
    sendMessage: vi.fn(),
    shutdown: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TwilioWebhookController();

    // Set up adapter in channel manager
    const instanceMap = new Map();
    instanceMap.set("whatsapp", mockAdapter);
    mockChannelManager.adapters = new Map();
    mockChannelManager.adapters.set("test-instance", instanceMap);

    // Default: instance found, config found
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { accountSid: "AC123", authToken: "token", whatsappNumber: "+14155238886" },
    });
  });

  it("processes a valid inbound message and returns TwiML", async () => {
    const result = await controller.handleWhatsAppWebhook(
      "test-instance",
      "valid-sig",
      validBody,
      mockReq(),
    );

    expect(result).toBe("<Response/>");
    expect(mockAdapter.validateSignature).toHaveBeenCalledWith(
      "valid-sig",
      "https://example.ngrok-free.dev/webhooks/twilio/test-instance/whatsapp",
      expect.objectContaining({ Body: "Hello agent" }),
    );
    expect(mockAdapter.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "+393331234567",
        body: "Hello agent",
        profileName: "Paolo",
        messageSid: "SM123",
        instanceId: "test-instance",
      }),
    );
  });

  it("uses X-Forwarded-Proto and X-Forwarded-Host when behind proxy", async () => {
    const req = mockReq({
      protocol: "http",
      headers: {
        host: "localhost:4000",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "my-app.ngrok-free.dev",
      },
      get: (name: string) => name === "host" ? "localhost:4000" : undefined,
    });

    await controller.handleWhatsAppWebhook("test-instance", "valid-sig", validBody, req);

    expect(mockAdapter.validateSignature).toHaveBeenCalledWith(
      "valid-sig",
      "https://my-app.ngrok-free.dev/webhooks/twilio/test-instance/whatsapp",
      expect.any(Object),
    );
  });

  it("returns 404 when instance not found", async () => {
    mockResolveInstanceId.mockResolvedValue(undefined);

    const promise = controller.handleWhatsAppWebhook("unknown", "sig", validBody, mockReq());

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    await expect(promise).rejects.toThrow(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
  });

  it("returns 404 when whatsapp channel not configured", async () => {
    mockGetChannelConfig.mockResolvedValue(null);

    const promise = controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq());

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    await expect(promise).rejects.toThrow(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
  });

  it("returns 403 when signature is invalid", async () => {
    mockAdapter.validateSignature.mockReturnValueOnce(false);

    const promise = controller.handleWhatsAppWebhook("test-instance", "bad-sig", validBody, mockReq());

    await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
    await expect(promise).rejects.toThrow(/Invalid Twilio signature/);
  });

  it("returns 404 when adapter is not active", async () => {
    mockChannelManager.adapters = new Map(); // no adapters

    const promise = controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq());

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    await expect(promise).rejects.toThrow(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
  });

  it("answers the exact same 404 message for a mode mismatch as for a genuinely unconfigured channel", async () => {
    // Mode mismatch: an apiKey-configured channel hit on the authToken/signature route.
    mockGetChannelConfig.mockResolvedValueOnce({
      channelType: "whatsapp",
      enabled: true,
      config: { authMode: "apiKey", webhookSecret: "secret" },
    });
    const modeMismatch = controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq());
    let modeMismatchMessage: string | undefined;
    await modeMismatch.catch((err) => {
      modeMismatchMessage = (err as Error).message;
    });

    // Genuinely unconfigured: no channel config at all.
    mockGetChannelConfig.mockResolvedValueOnce(null);
    const unconfigured = controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq());
    let unconfiguredMessage: string | undefined;
    await unconfigured.catch((err) => {
      unconfiguredMessage = (err as Error).message;
    });

    // Pinned so a future edit that adds detail to only one of these (e.g.
    // "(wrong mode)") fails this test rather than silently re-opening the
    // slug/channel-configuration enumeration oracle.
    expect(modeMismatchMessage).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    expect(unconfiguredMessage).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    expect(modeMismatchMessage).toBe(unconfiguredMessage);
  });

  it("clamps a huge NumMedia to at most 10 media items", async () => {
    const mediaBody: Record<string, string> = { ...validBody, NumMedia: "999999999" };
    for (let i = 0; i < 15; i++) {
      mediaBody[`MediaUrl${i}`] = `https://example.com/media-${i}.jpg`;
      mediaBody[`MediaContentType${i}`] = "image/jpeg";
    }

    await controller.handleWhatsAppWebhook("test-instance", "valid-sig", mediaBody as never, mockReq());

    const call = mockAdapter.handleInbound.mock.calls[0][0] as { media?: unknown[] };
    expect(call.media).toHaveLength(10);
  });

  describe("apiKey mode (path secret)", () => {
    const SECRET = "0123456789abcdef0123456789abcdef";

    beforeEach(() => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: {
          authMode: "apiKey",
          accountSid: "AC00000000000000000000000000000001",
          apiKeySid: "SK00000000000000000000000000000002",
          apiKeySecret: "sec",
          webhookSecret: SECRET,
          whatsappNumber: "+14155238886",
        },
      });
    });

    it("processes an inbound message when the secret matches", async () => {
      const result = await controller.handleWhatsAppWebhookWithSecret("test-instance", SECRET, validBody);

      expect(result).toBe("<Response/>");
      expect(mockAdapter.validateSignature).not.toHaveBeenCalled();
      expect(mockAdapter.handleInbound).toHaveBeenCalledWith(
        expect.objectContaining({ from: "+393331234567", body: "Hello agent", messageSid: "SM123" }),
      );
    });

    it("rejects a wrong secret without processing the message", async () => {
      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", "wrong-secret", validBody);

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(/Invalid webhook credentials/);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects a secret of a different length (no length oracle)", async () => {
      // An implementation that dropped the SHA-256 hashing and called
      // timingSafeEqual on raw buffers would throw a bare RangeError here —
      // which the global filter maps to 400, not 403 — leaking the secret's
      // byte length through the response status code. Assert the specific
      // rejection so that regression is caught.
      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", "short", validBody);

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(/Invalid webhook credentials/);
    });

    it("rejects when the stored webhookSecret is missing", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { authMode: "apiKey", whatsappNumber: "+14155238886" },
      });

      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", SECRET, validBody);

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects when the stored webhookSecret is an empty string", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { authMode: "apiKey", webhookSecret: "", whatsappNumber: "+14155238886" },
      });

      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", "", validBody);

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects when the stored webhookSecret is not a string", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { authMode: "apiKey", webhookSecret: 12345, whatsappNumber: "+14155238886" },
      });

      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", SECRET, validBody);

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("never logs the secret", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "wrong-secret", validBody),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[whatsapp] Invalid webhook secret for instance:", "test-instance");
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();

      const allLoggedText = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls, ...debug.mock.calls]
        .flat()
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      expect(allLoggedText).not.toContain(SECRET);
      expect(allLoggedText).not.toContain("wrong-secret");

      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
      debug.mockRestore();
    });

    it("answers 404 on the signature route for an apiKey channel", async () => {
      const promise = controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq());

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    });
  });

  it("collects a __proto__ body field as a plain key, not a prototype write", async () => {
    // A plain object literal with `__proto__: "polluted"` invokes the
    // Object.prototype accessor setter and silently no-ops — the resulting
    // body would have NO "__proto__" own key at all, making this test pass
    // for any implementation, including a naive `params[key] = value`.
    // JSON.parse uses CreateDataProperty internally, so it produces a real
    // own data property named "__proto__" without touching the prototype.
    const bodyWithProto = JSON.parse(
      `{"__proto__":"polluted","MessageSid":"${validBody.MessageSid}","From":"${validBody.From}","To":"${validBody.To}","Body":"${validBody.Body}","ProfileName":"${validBody.ProfileName}"}`,
    );

    await controller.handleWhatsAppWebhook("test-instance", "valid-sig", bodyWithProto, mockReq());

    const params = mockAdapter.validateSignature.mock.calls[0][2] as Record<string, unknown>;
    // Twilio signs every field it sends, so the key must reach the validator
    // verbatim — while never retargeting the prototype chain.
    expect(Object.keys(params)).toContain("__proto__");
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("collectSignedParams collects a __proto__ field as a plain key (direct unit test)", () => {
    const bodyWithProto = JSON.parse('{"__proto__":"polluted","MessageSid":"SM123","From":"whatsapp:+1"}');

    const params = collectSignedParams(bodyWithProto);

    expect(Object.keys(params)).toContain("__proto__");
    expect(params.__proto__).toBe("polluted");
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("answers 404 on the secret route for an authToken channel", async () => {
    // Default beforeEach config is an authToken channel.
    const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", "any-secret", validBody);

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    await expect(promise).rejects.toThrow(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
  });
});
