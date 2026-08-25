// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { TwilioWebhookController } from "./twilio-webhook.controller.js";

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

    await expect(
      controller.handleWhatsAppWebhook("unknown", "sig", validBody, mockReq()),
    ).rejects.toThrow();
  });

  it("returns 404 when whatsapp channel not configured", async () => {
    mockGetChannelConfig.mockResolvedValue(null);

    await expect(
      controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq()),
    ).rejects.toThrow();
  });

  it("returns 403 when signature is invalid", async () => {
    mockAdapter.validateSignature.mockReturnValueOnce(false);

    await expect(
      controller.handleWhatsAppWebhook("test-instance", "bad-sig", validBody, mockReq()),
    ).rejects.toThrow();
  });

  it("returns 404 when adapter is not active", async () => {
    mockChannelManager.adapters = new Map(); // no adapters

    await expect(
      controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq()),
    ).rejects.toThrow();
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
      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "wrong-secret", validBody),
      ).rejects.toThrow();
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects a secret of a different length (no length oracle)", async () => {
      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "short", validBody),
      ).rejects.toThrow();
    });

    it("never logs the secret", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "wrong-secret", validBody),
      ).rejects.toThrow();

      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("wrong-secret");
      warn.mockRestore();
    });

    it("answers 404 on the signature route for an apiKey channel", async () => {
      await expect(
        controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq()),
      ).rejects.toThrow(/not configured/);
    });
  });

  it("collects a __proto__ body field as a plain key, not a prototype write", async () => {
    await controller.handleWhatsAppWebhook(
      "test-instance",
      "valid-sig",
      { ...validBody, __proto__: "polluted" } as never,
      mockReq(),
    );

    const params = mockAdapter.validateSignature.mock.calls[0][2] as Record<string, unknown>;
    // Twilio signs every field it sends, so the key must reach the validator
    // verbatim — while never retargeting the prototype chain.
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("answers 404 on the secret route for an authToken channel", async () => {
    // Default beforeEach config is an authToken channel.
    await expect(
      controller.handleWhatsAppWebhookWithSecret("test-instance", "any-secret", validBody),
    ).rejects.toThrow(/not configured/);
  });
});
