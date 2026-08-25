// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { redactWebhookPath, REDACTED_PLACEHOLDER } from "./redact-webhook-path.js";

describe("redactWebhookPath", () => {
  it("masks the trailing secret of the Twilio API-Key webhook route, keeping the slug", () => {
    const result = redactWebhookPath("/webhooks/twilio/acme-support/whatsapp/0123456789abcdef0123456789abcdef");

    expect(result).toBe(`/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}`);
  });

  it("masks the token of the generic Room event-source webhook route", () => {
    const result = redactWebhookPath("/webhooks/8f3a9c2b7e1d4f6a9b0c5d2e7f1a3b6c");

    expect(result).toBe(`/webhooks/${REDACTED_PLACEHOLDER}`);
  });

  it("drops a query string on the Twilio secret route", () => {
    const result = redactWebhookPath("/webhooks/twilio/acme-support/whatsapp/mysecret?foo=bar");

    expect(result).toBe(`/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}`);
    expect(result).not.toContain("foo=bar");
  });

  it("drops a query string on the generic token route", () => {
    const result = redactWebhookPath("/webhooks/abcdef123456?x=1");

    expect(result).toBe(`/webhooks/${REDACTED_PLACEHOLDER}`);
    expect(result).not.toContain("x=1");
  });

  it("drops a query string on a non-webhook path without altering the path segments", () => {
    const result = redactWebhookPath("/api/instances/acme?slug=acme");

    expect(result).toBe("/api/instances/acme");
  });

  it("returns a non-webhook path unchanged", () => {
    const result = redactWebhookPath("/api/instances/acme/prompts");

    expect(result).toBe("/api/instances/acme/prompts");
  });

  it("returns the Auth-Token-mode Twilio route unchanged (it carries no path secret)", () => {
    const result = redactWebhookPath("/webhooks/twilio/acme-support/whatsapp");

    expect(result).toBe("/webhooks/twilio/acme-support/whatsapp");
  });

  it("does not throw on a trailing slash and preserves it", () => {
    expect(() => redactWebhookPath("/webhooks/twilio/acme-support/whatsapp/mysecret/")).not.toThrow();

    const result = redactWebhookPath("/webhooks/twilio/acme-support/whatsapp/mysecret/");
    expect(result).toBe(`/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}/`);
  });

  it("does not throw on extra unexpected path segments", () => {
    expect(() =>
      redactWebhookPath("/webhooks/twilio/acme-support/whatsapp/mysecret/extra/segments"),
    ).not.toThrow();
  });

  it("does not throw on an empty path", () => {
    expect(() => redactWebhookPath("")).not.toThrow();
    expect(redactWebhookPath("")).toBe("");
  });

  it("does not throw on a URL-encoded secret segment", () => {
    const encoded = "/webhooks/twilio/acme-support/whatsapp/my%2Fsecret%20value";

    expect(() => redactWebhookPath(encoded)).not.toThrow();
    expect(redactWebhookPath(encoded)).toBe(`/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}`);
  });

  it("never lets a realistic 64-hex secret survive in the output", () => {
    const secret = "a".repeat(32) + "b".repeat(32); // 64 hex chars, like a real webhookSecret
    const result = redactWebhookPath(`/webhooks/twilio/acme-support/whatsapp/${secret}?foo=${secret}`);

    expect(result).not.toContain(secret);
    expect(result).toBe(`/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}`);
  });

  it("never lets a realistic 64-hex Room webhook token survive in the output", () => {
    const token = "c".repeat(64);
    const result = redactWebhookPath(`/webhooks/${token}`);

    expect(result).not.toContain(token);
    expect(result).toBe(`/webhooks/${REDACTED_PLACEHOLDER}`);
  });
});
