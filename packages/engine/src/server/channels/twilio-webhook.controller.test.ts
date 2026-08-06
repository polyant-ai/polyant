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

  it("clamps NumMedia so an absurd count cannot spin the media loop", async () => {
    // NumMedia arrives on the request body. Without the clamp this would iterate
    // a billion times looking up MediaUrl<i> keys that do not exist.
    await controller.handleWhatsAppWebhook(
      "test-instance",
      "valid-sig",
      { ...validBody, NumMedia: "999999999", MediaUrl0: "https://api.twilio.com/m0", MediaContentType0: "image/jpeg" },
      mockReq(),
    );

    const [payload] = mockAdapter.handleInbound.mock.calls[0];
    // Only the one attachment that actually exists is collected.
    expect(payload.media).toEqual([{ url: "https://api.twilio.com/m0", contentType: "image/jpeg" }]);
  });

  it("ignores a __proto__ key in the body when building the signature params", async () => {
    await controller.handleWhatsAppWebhook(
      "test-instance",
      "valid-sig",
      { ...validBody, ["__proto__"]: "polluted" } as never,
      mockReq(),
    );

    const [, , params] = mockAdapter.validateSignature.mock.calls[0];
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(params.__proto__).not.toBe("polluted");
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
});
