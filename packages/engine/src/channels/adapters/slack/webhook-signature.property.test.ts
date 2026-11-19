// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { asInstanceSlug } from "../../../instances/identifiers.js";
import { SlackAdapter } from "./index.js";

/*
  Slack request signing, checked against the documented algorithm computed
  here with node:crypto: `v0=` + hex(HMAC-SHA256(signing secret,
  "v0:" + timestamp + ":" + raw body)), timestamp within five minutes.
  https://api.slack.com/authentication/verifying-requests-from-slack
*/

function slackSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  return "v0=" + createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody])).digest("hex");
}

function adapterWith(secret: string): SlackAdapter {
  return new SlackAdapter(asInstanceSlug("agent"), { botToken: "fake-bot-token", signingSecret: secret });
}

const SECRET = fc.string({ unit: "grapheme", minLength: 1, maxLength: 48 });
// Slack sends JSON or form-encoded bodies: valid UTF-8 of any content.
const BODY = fc.string({ unit: "grapheme", maxLength: 400 }).map((s) => Buffer.from(s, "utf8"));
const now = () => Math.floor(Date.now() / 1000);

describe("Slack webhook signature (property)", () => {
  it("accepts a request signed by the documented algorithm, for any body and secret", () => {
    // Catches a body re-encoded before hashing (latin1, a re-serialised JSON)
    // or a base string assembled in a different order.
    fc.assert(
      fc.property(SECRET, BODY, fc.integer({ min: -290, max: 290 }), (secret, body, skew) => {
        const timestamp = now() + skew;
        expect(adapterWith(secret).verifyRequest(body, slackSignature(secret, timestamp, body), String(timestamp))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects the request when any byte of the body or the signature changes", () => {
    fc.assert(
      fc.property(
        SECRET,
        BODY.filter((b) => b.length > 0),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        fc.boolean(),
        (secret, body, at, mask, inBody) => {
          const timestamp = now();
          const signature = slackSignature(secret, timestamp, body);
          const adapter = adapterWith(secret);
          if (inBody) {
            const tampered = Buffer.from(body);
            tampered[at % tampered.length]! ^= mask;
            expect(adapter.verifyRequest(tampered, signature, String(timestamp))).toBe(false);
          } else {
            const bytes = Buffer.from(signature, "latin1");
            bytes[at % bytes.length]! ^= mask;
            expect(adapter.verifyRequest(body, bytes.toString("latin1"), String(timestamp))).toBe(false);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("rejects a signature made with any other secret", () => {
    fc.assert(
      fc.property(SECRET, SECRET, BODY, (secret, other, body) => {
        fc.pre(secret !== other);
        const timestamp = now();
        expect(adapterWith(secret).verifyRequest(body, slackSignature(other, timestamp, body), String(timestamp))).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("answers false, without throwing, to a signature of the wrong length or shape", () => {
    // timingSafeEqual throws on a length mismatch; a comparison built on it
    // without a length guard turns a junk header into a 500.
    const junk = fc.oneof(
      fc.string({ maxLength: 120 }),
      fc.nat({ max: 70 }).map((n) => (s: string) => s.slice(0, n)),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.startsWith("=")).map((x) => (s: string) => s + x),
    );
    fc.assert(
      fc.property(SECRET, BODY, junk, (secret, body, make) => {
        const timestamp = now();
        const valid = slackSignature(secret, timestamp, body);
        const signature = typeof make === "string" ? make : make(valid);
        fc.pre(signature !== valid);
        expect(adapterWith(secret).verifyRequest(body, signature, String(timestamp))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects a correctly signed request whose timestamp is more than five minutes away, in either direction", () => {
    // Catches a replay window that only looks backwards: a request stamped in
    // the future stays replayable for as long as the stamp is ahead.
    fc.assert(
      fc.property(SECRET, BODY, fc.integer({ min: 310, max: 10 * 365 * 86_400 }), fc.boolean(), (secret, body, distance, future) => {
        const timestamp = now() + (future ? distance : -distance);
        expect(adapterWith(secret).verifyRequest(body, slackSignature(secret, timestamp, body), String(timestamp))).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
