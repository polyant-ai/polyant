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

// This file covers the Auth-Token/signature route
// (`handleWhatsAppWebhook` — `POST /webhooks/twilio/:instanceSlug/whatsapp`).
// The path-secret route (`handleWhatsAppWebhookWithSecret`) has its own
// dedicated file: `twilio-webhook-secret.controller.test.ts`.
describe("TwilioWebhookController (signature route)", () => {
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

  /**
   * The key is KEPT, and that is the fix rather than a weaker version of it.
   *
   * An earlier denylist dropped `__proto__` before hashing, which is the wrong
   * answer here: Twilio signs EVERY parameter it sends and adds new ones over
   * time, so a webhook carrying a field we silently discard fails validation
   * outright. The finding (js/remote-property-injection) is that remote input
   * chooses which property gets WRITTEN — and `Object.fromEntries` answers it by
   * defining own data properties, so the entry lands as a flat key exactly as
   * Twilio hashed it instead of retargeting the prototype chain.
   *
   * The prototype assertion is therefore the one carrying the security property.
   */
  it("keeps a __proto__ key as a flat own property, never on the prototype", async () => {
    // JSON.parse is how such a body actually arrives, and it yields a real OWN
    // enumerable "__proto__" property that Object.entries will hand back — an object
    // literal cannot express that (it would just set the prototype).
    const pollutedBody = Object.assign(
      JSON.parse('{"__proto__": "polluted"}'),
      validBody,
    );

    await controller.handleWhatsAppWebhook(
      "test-instance",
      "valid-sig",
      pollutedBody,
      mockReq(),
    );

    const [, , params] = mockAdapter.validateSignature.mock.calls[0];
    // Hashed with the others, as Twilio signed it — and as DATA, so nothing the
    // body named can reach the prototype chain of the object we build.
    expect(Object.hasOwn(params, "__proto__")).toBe(true);
    expect(params["__proto__" as keyof typeof params]).toBe("polluted");
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    // Sanity: the body really did carry it as an own property, so this exercised
    // the path it was written for.
    expect(Object.hasOwn(pollutedBody, "__proto__")).toBe(true);
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

  it("answers 404 on the signature route for an apiKey channel", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: {
        authMode: "apiKey",
        webhookSecret: "0123456789abcdef0123456789abcdef",
        whatsappNumber: "+14155238886",
      },
    });

    const promise = controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq());

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    await expect(promise).rejects.toThrow(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
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
});
