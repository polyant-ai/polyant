// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { NotFoundException } from "@nestjs/common";

/*
  The two ways the Twilio webhook authenticates a caller:
  - apiKey mode: a server-generated secret in the path, compared in constant
    time. Accepted exactly when it equals the stored secret; anything else,
    of any length, is the uniform 404 (never a crash from timingSafeEqual).
  - authToken mode: X-Twilio-Signature over every POST parameter. The
    parameters handed to the validator must be exactly the ones Twilio signed,
    including names shaped like Object.prototype keys.
  Only the stores and the channel manager (database and process state) are
  stubbed; the real Twilio SDK validates.
*/

const { channel } = vi.hoisted(() => ({
  channel: { config: {} as Record<string, unknown>, adapter: {} as Record<string, unknown> },
}));

vi.mock("../../instances/channels.store.js", () => ({
  getChannelConfig: async () => ({ channelType: "whatsapp", enabled: true, config: channel.config }),
  WHATSAPP_CHANNEL_TYPE: "whatsapp",
  WHATSAPP_AUTH_MODE_TOKEN: "authToken",
  WHATSAPP_AUTH_MODE_API_KEY: "apiKey",
  resolveWhatsAppAuthMode: (cfg: Record<string, unknown>) => (cfg.authMode === "apiKey" ? "apiKey" : "authToken"),
}));
vi.mock("../../instances/resolve-instance-id.js", () => ({ resolveInstanceId: async () => "uuid-1" }));
vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: { getAdapter: () => channel.adapter },
}));

import { TwilioWebhookController, collectSignedParams } from "./twilio-webhook.controller.js";
import { TwilioWhatsAppClient } from "../../channels/adapters/whatsapp/twilio-client.js";

const body = { MessageSid: "", From: "whatsapp:+390000000000", To: "whatsapp:+15550000000", Body: "hi" };

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  channel.adapter = { handleInbound: vi.fn().mockResolvedValue(undefined) };
});

describe("Twilio webhook authentication (property)", () => {
  it("apiKey route: accepts exactly the stored path secret and answers the uniform 404 to anything else", async () => {
    const secret = fc.oneof(fc.stringMatching(/^[0-9a-f]{32,64}$/), fc.string({ unit: "grapheme", minLength: 1, maxLength: 64 }));
    const received = (stored: string) =>
      fc.oneof(
        fc.constant(stored),
        fc.string({ unit: "grapheme", maxLength: 80 }),
        fc.nat({ max: 80 }).map((n) => stored.slice(0, n)), // a prefix: shorter, so lengths differ
        fc.string({ minLength: 1, maxLength: 8 }).map((x) => stored + x),
      );
    await fc.assert(
      fc.asyncProperty(
        secret.chain((stored) => fc.tuple(fc.constant(stored), received(stored))),
        async ([stored, sent]) => {
          channel.config = { authMode: "apiKey", webhookSecret: stored };
          const controller = new TwilioWebhookController();
          const outcome = controller.handleWhatsAppWebhookWithSecret("agent", sent, body);
          if (sent === stored) await expect(outcome).resolves.toBe("<Response/>");
          else await expect(outcome).rejects.toBeInstanceOf(NotFoundException);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("authToken route: the parameters passed to the validator are exactly the signed ones, whatever their names", () => {
    // Catches a body copy that loses or renames a field (a plain `out[k] = v`
    // drops `__proto__`), which turns every such webhook into a 403.
    const name = fc.oneof(
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,15}$/),
      fc.constantFrom("__proto__", "constructor", "hasOwnProperty", "Body", "NumMedia"),
    );
    const entries = fc.uniqueArray(fc.tuple(name, fc.string({ unit: "grapheme", maxLength: 40 })), {
      selector: ([n]) => n,
      maxLength: 10,
    });
    const token = "0123456789abcdef0123456789abcdef";
    const client = TwilioWhatsAppClient.create(
      { mode: "authToken", accountSid: "AC" + "0".repeat(32), authToken: token },
      "+15550000000",
    );
    const url = "https://agents.example.com/webhooks/twilio/agent/whatsapp";
    fc.assert(
      fc.property(entries, (pairs) => {
        // Twilio's documented base string, built from the pairs as sent.
        const data = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).reduce((acc, [k, v]) => acc + k + v, url);
        const signature = createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
        const parsedBody = Object.fromEntries(pairs);
        expect(client.validateWebhook(signature, url, collectSignedParams(parsedBody as never))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
