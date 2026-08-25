// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";

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

import { TwilioWebhookController, WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE } from "./twilio-webhook.controller.js";

// This file covers the API-Key/path-secret route
// (`handleWhatsAppWebhookWithSecret` —
// `POST /webhooks/twilio/:instanceSlug/whatsapp/:webhookSecret`).
// The Auth-Token/signature route (`handleWhatsAppWebhook`) has its own
// dedicated file: `twilio-webhook-signature.controller.test.ts`.
describe("TwilioWebhookController (path secret route)", () => {
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

    // Default: instance found, config found (authToken mode)
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { accountSid: "AC123", authToken: "token", whatsappNumber: "+14155238886" },
    });
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

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      // `toThrow(string)` is substring semantics, so a message that grew a
      // suffix (e.g. " (invalid secret)") would still pass it — and NestJS
      // puts the exception message verbatim in the response body, which
      // would re-open the enumeration oracle the shared 404 exists to close.
      // Capture the error and pin the exact message instead.
      let caught: Error | undefined;
      await promise.catch((err) => {
        caught = err as Error;
      });
      expect(caught?.message).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects a secret of a different length (no length oracle)", async () => {
      // An implementation that dropped the SHA-256 hashing and called
      // timingSafeEqual on raw buffers would throw a bare RangeError here —
      // which the global filter maps to 400, not the shared 404 — leaking
      // the secret's byte length through the response status code. Assert
      // the specific rejection so that regression is caught.
      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", "short", validBody);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      let caught: Error | undefined;
      await promise.catch((err) => {
        caught = err as Error;
      });
      expect(caught?.message).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    });

    it("rejects when the stored webhookSecret is missing", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { authMode: "apiKey", whatsappNumber: "+14155238886" },
      });

      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", SECRET, validBody);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      let caught: Error | undefined;
      await promise.catch((err) => {
        caught = err as Error;
      });
      expect(caught?.message).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects when the stored webhookSecret is an empty string", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { authMode: "apiKey", webhookSecret: "", whatsappNumber: "+14155238886" },
      });

      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", "", validBody);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      let caught: Error | undefined;
      await promise.catch((err) => {
        caught = err as Error;
      });
      expect(caught?.message).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects when the stored webhookSecret is not a string", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { authMode: "apiKey", webhookSecret: 12345, whatsappNumber: "+14155238886" },
      });

      const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", SECRET, validBody);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      let caught: Error | undefined;
      await promise.catch((err) => {
        caught = err as Error;
      });
      expect(caught?.message).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("never logs the secret", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const info = vi.spyOn(console, "info").mockImplementation(() => {});

      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "wrong-secret", validBody),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[whatsapp] Invalid webhook secret for instance:", "test-instance");
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();

      const allLoggedText = [
        ...warn.mock.calls,
        ...error.mock.calls,
        ...log.mock.calls,
        ...debug.mock.calls,
        ...info.mock.calls,
      ]
        .flat()
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      expect(allLoggedText).not.toContain(SECRET);
      expect(allLoggedText).not.toContain("wrong-secret");

      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
      debug.mockRestore();
      info.mockRestore();
    });
  });

  it("sanitizes a forged newline in the instance slug before logging (CWE-117)", async () => {
    // Express decodes percent-escapes in a path segment, so a request to
    // `/webhooks/twilio/foo%0A%5BINFO%5D%20forged/whatsapp/...` arrives here
    // with `instanceSlug === "foo\n[INFO] forged"`. Without sanitization that
    // newline would land in the plaintext log file as a second, forged record.
    const forgedSlug = "foo\n[INFO] forged";
    mockResolveInstanceId.mockResolvedValue(undefined);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = controller.handleWhatsAppWebhookWithSecret(forgedSlug, "any-secret", validBody);
    await expect(promise).rejects.toBeInstanceOf(NotFoundException);

    const loggedText = warn.mock.calls.flat().map(String).join(" ");
    expect(loggedText).not.toContain("\n");
    expect(loggedText).toContain("foo [INFO] forged");

    warn.mockRestore();
  });

  it("answers 404 on the secret route for an authToken channel", async () => {
    // Default beforeEach config is an authToken channel.
    const promise = controller.handleWhatsAppWebhookWithSecret("test-instance", "any-secret", validBody);

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    // `toThrow(string)` is substring semantics — it would still pass if the
    // real message grew a suffix like " (wrong mode: expected apiKey)",
    // which is exactly the mode-mismatch detail this route must not reveal
    // to an anonymous prober. Pin the exact message instead.
    let caught: Error | undefined;
    await promise.catch((err) => {
      caught = err as Error;
    });
    expect(caught?.message).toBe(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
  });
});
