// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TwilioWhatsAppClient } from "./twilio-client.js";

/*
  X-Twilio-Signature, checked against the documented algorithm computed here
  with node:crypto: base64(HMAC-SHA1(auth token, full URL + every POST
  parameter as name+value, names sorted))
  https://www.twilio.com/docs/usage/webhooks/webhooks-security
  The real Twilio SDK runs; nothing is mocked (validation makes no request).
*/

function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function clientFor(authToken: string): TwilioWhatsAppClient {
  return TwilioWhatsAppClient.create({ mode: "authToken", accountSid: "AC" + "0".repeat(32), authToken }, "+15550000000");
}

const TOKEN = fc.stringMatching(/^[0-9a-f]{32}$/);
const URL_ARB = fc
  .stringMatching(/^[a-z0-9-]{1,24}$/)
  .map((slug) => `https://agents.example.com/webhooks/twilio/${slug}/whatsapp`);
// Twilio parameter names are ASCII words; the prototype-shaped names are the
// ones a careless body copy loses.
const NAME = fc.oneof(
  fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,15}$/),
  fc.constantFrom("Body", "From", "To", "MessageSid", "__proto__", "constructor", "toString"),
);
const PARAMS = fc
  .uniqueArray(fc.tuple(NAME, fc.string({ unit: "grapheme", maxLength: 80 })), {
    selector: ([name]) => name,
    maxLength: 12,
  })
  .map((entries) => Object.fromEntries(entries) as Record<string, string>);

describe("Twilio webhook signature (property)", () => {
  it("accepts a request signed by the documented algorithm, for any URL, parameters and token", () => {
    fc.assert(
      fc.property(TOKEN, URL_ARB, PARAMS, (token, url, params) => {
        expect(clientFor(token).validateWebhook(twilioSignature(token, url, params), url, params)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects the request when a parameter value, the parameter set, the URL or the signature changes", () => {
    const tamper = fc.oneof(
      fc.record({ kind: fc.constant("value" as const), at: fc.nat(), value: fc.string({ maxLength: 20 }) }),
      fc.record({ kind: fc.constant("drop" as const), at: fc.nat() }),
      fc.record({ kind: fc.constant("add" as const), name: NAME, value: fc.string({ maxLength: 20 }) }),
      fc.record({ kind: fc.constant("url" as const), suffix: fc.stringMatching(/^[a-z0-9]{1,4}$/) }),
      fc.record({ kind: fc.constant("signature" as const), at: fc.nat(), mask: fc.integer({ min: 1, max: 255 }) }),
    );
    fc.assert(
      fc.property(TOKEN, URL_ARB, PARAMS, tamper, (token, url, params, t) => {
        const signature = twilioSignature(token, url, params);
        const names = Object.keys(params);
        let sentUrl = url;
        let sentSignature = signature;
        const sent: Record<string, string> = Object.fromEntries(Object.entries(params));
        if (t.kind === "value") {
          fc.pre(names.length > 0);
          const name = names[t.at % names.length]!;
          fc.pre(sent[name] !== t.value);
          Object.defineProperty(sent, name, { value: t.value, enumerable: true, writable: true, configurable: true });
        } else if (t.kind === "drop") {
          fc.pre(names.length > 0);
          delete sent[names[t.at % names.length]!];
        } else if (t.kind === "add") {
          fc.pre(!Object.hasOwn(sent, t.name));
          Object.defineProperty(sent, t.name, { value: t.value, enumerable: true, writable: true, configurable: true });
        } else if (t.kind === "url") {
          sentUrl = url.replace("/whatsapp", `${t.suffix}/whatsapp`);
        } else {
          const bytes = Buffer.from(signature, "base64");
          bytes[t.at % bytes.length]! ^= t.mask;
          sentSignature = bytes.toString("base64");
        }
        expect(clientFor(token).validateWebhook(sentSignature, sentUrl, sent)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it("rejects a signature made with any other auth token", () => {
    fc.assert(
      fc.property(TOKEN, TOKEN, URL_ARB, PARAMS, (token, other, url, params) => {
        fc.pre(token !== other);
        expect(clientFor(token).validateWebhook(twilioSignature(other, url, params), url, params)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("answers false, without throwing, to a signature header of any other length or content", () => {
    // timingSafeEqual throws on a length mismatch; an unguarded comparison
    // turns a junk header into a 500 instead of a 403.
    fc.assert(
      fc.property(TOKEN, URL_ARB, PARAMS, fc.string({ maxLength: 80 }), (token, url, params, header) => {
        fc.pre(header !== twilioSignature(token, url, params));
        expect(clientFor(token).validateWebhook(header, url, params)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
