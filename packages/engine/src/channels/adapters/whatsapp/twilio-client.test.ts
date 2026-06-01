// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate, mockValidateRequest } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ sid: "SM123" }),
  mockValidateRequest: vi.fn().mockReturnValue(true),
}));

vi.mock("twilio", () => {
  const client = {
    messages: { create: mockCreate },
  };
  const Twilio = vi.fn(() => client);
  (Twilio as any).validateRequest = mockValidateRequest;
  return { default: Twilio, Twilio };
});

import { TwilioWhatsAppClient } from "./twilio-client.js";

describe("TwilioWhatsAppClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("creates a client with valid credentials", () => {
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      expect(client).toBeDefined();
    });

    it("throws for empty accountSid", () => {
      expect(() => TwilioWhatsAppClient.create("", "token", "+14155238886")).toThrow();
    });

    it("throws for empty authToken", () => {
      expect(() => TwilioWhatsAppClient.create("AC123", "", "+14155238886")).toThrow();
    });

    it("throws for invalid whatsappNumber (missing +)", () => {
      expect(() => TwilioWhatsAppClient.create("AC123", "token", "14155238886")).toThrow();
    });
  });

  describe("sendMessage", () => {
    it("sends a message with correct whatsapp: prefixes", async () => {
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await client.sendMessage("+393331234567", "Hello from agent");

      expect(mockCreate).toHaveBeenCalledWith({
        from: "whatsapp:+14155238886",
        to: "whatsapp:+393331234567",
        body: "Hello from agent",
      });
    });

    it("strips whatsapp: prefix from 'to' if already present", async () => {
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await client.sendMessage("whatsapp:+393331234567", "Hello");

      expect(mockCreate).toHaveBeenCalledWith({
        from: "whatsapp:+14155238886",
        to: "whatsapp:+393331234567",
        body: "Hello",
      });
    });

    it("splits long messages below the Twilio 1600-char API limit", async () => {
      // Twilio Programmable Messaging rejects body > 1600 chars (error 21617),
      // so CHANNEL_MAX_LENGTH.whatsapp caps at 1600 even though the WhatsApp
      // app accepts ~4096. Ref: https://www.twilio.com/docs/errors/21617
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      const longText = "A".repeat(4500);
      await client.sendMessage("+393331234567", longText);

      // 4500 chars / 1600 cap = 3 chunks (1600 + 1600 + 1300).
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    it("attaches mediaUrl on the first chunk only", async () => {
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      const longText = "A".repeat(3500);
      await client.sendMessage("+393331234567", longText, {
        mediaUrl: ["https://hubspot.example/file/abc.pdf"],
      });

      expect(mockCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
      const firstCall = mockCreate.mock.calls[0][0] as { mediaUrl?: string[] };
      expect(firstCall.mediaUrl).toEqual(["https://hubspot.example/file/abc.pdf"]);
      for (let i = 1; i < mockCreate.mock.calls.length; i++) {
        const c = mockCreate.mock.calls[i][0] as { mediaUrl?: string[] };
        expect(c.mediaUrl).toBeUndefined();
      }
    });

    it("sends a media-only message with empty body when text is empty", async () => {
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await client.sendMessage("+393331234567", "", {
        mediaUrl: ["https://hubspot.example/file/abc.pdf"],
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith({
        from: "whatsapp:+14155238886",
        to: "whatsapp:+393331234567",
        body: "",
        mediaUrl: ["https://hubspot.example/file/abc.pdf"],
      });
    });
  });

  describe("sendTemplate", () => {
    it("sends a template with contentSid and JSON-stringified variables", async () => {
      mockCreate.mockResolvedValueOnce({ sid: "SM_TPL_123" });
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      const sid = await client.sendTemplate("+393331234567", "HXabc", { "1": "Mario", "2": "14:30" });

      expect(mockCreate).toHaveBeenCalledWith({
        from: "whatsapp:+14155238886",
        to: "whatsapp:+393331234567",
        contentSid: "HXabc",
        contentVariables: JSON.stringify({ "1": "Mario", "2": "14:30" }),
      });
      expect(sid).toBe("SM_TPL_123");
    });

    it("strips whatsapp: prefix from 'to'", async () => {
      mockCreate.mockResolvedValueOnce({ sid: "SM_TPL_456" });
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await client.sendTemplate("whatsapp:+393331234567", "HXabc", {});

      expect(mockCreate).toHaveBeenCalledWith({
        from: "whatsapp:+14155238886",
        to: "whatsapp:+393331234567",
        contentSid: "HXabc",
        contentVariables: "{}",
      });
    });

    it("propagates Twilio errors", async () => {
      mockCreate.mockRejectedValueOnce(new Error("invalid template"));
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await expect(client.sendTemplate("+393331234567", "HXabc", {})).rejects.toThrow("invalid template");
    });
  });

  describe("sendTypingIndicator", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    it("POSTs to the v2 Indicators/Typing endpoint with basic auth and form body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await client.sendTypingIndicator("SMabc");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://messaging.twilio.com/v2/Indicators/Typing.json");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const expectedAuth = "Basic " + Buffer.from("AC123:token123").toString("base64");
      expect(init.headers.Authorization).toBe(expectedAuth);
      const bodyParams = new URLSearchParams(init.body as string);
      expect(bodyParams.get("messageId")).toBe("SMabc");
      expect(bodyParams.get("channel")).toBe("whatsapp");
    });

    it("throws if Twilio responds with non-ok status", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue(`{"code":404,"message":"Message not found"}`),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await expect(client.sendTypingIndicator("SMbogus")).rejects.toThrow(/404/);
    });

    it("throws when messageSid is empty", async () => {
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      await expect(client.sendTypingIndicator("")).rejects.toThrow(/messageSid/i);
    });
  });

  describe("validateWebhook", () => {
    it("delegates to Twilio.validateRequest", () => {
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      const result = client.validateWebhook("sig", "https://example.com/webhook", { Body: "hi" });

      expect(mockValidateRequest).toHaveBeenCalledWith("token123", "sig", "https://example.com/webhook", { Body: "hi" });
      expect(result).toBe(true);
    });

    it("returns false when signature is invalid", () => {
      mockValidateRequest.mockReturnValueOnce(false);
      const client = TwilioWhatsAppClient.create("AC123", "token123", "+14155238886");
      const result = client.validateWebhook("badsig", "https://example.com/webhook", {});

      expect(result).toBe(false);
    });
  });
});
