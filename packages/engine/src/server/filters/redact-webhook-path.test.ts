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

  it("masks each trailing segment individually when extra unexpected path segments trail the secret (fail-safe default)", () => {
    // The fail-safe must preserve the SEGMENT COUNT — that's the detail an
    // operator needs to diagnose a mistyped webhook URL — rather than
    // collapsing the whole tail into one opaque token.
    const result = redactWebhookPath("/webhooks/twilio/acme-support/whatsapp/mysecret/extra/segments");

    expect(result).not.toContain("mysecret");
    expect(result).toBe(
      `/webhooks/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}`,
    );
  });

  it("masks a doubled slash before the secret while preserving the doubled slash (fail-safe default)", () => {
    const result = redactWebhookPath("/webhooks/twilio/acme-support/whatsapp//mysecret");

    expect(result).not.toContain("mysecret");
    expect(result).toBe(
      `/webhooks/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}//${REDACTED_PLACEHOLDER}`,
    );
  });

  it("masks a leading doubled slash before /webhooks/, keeping the leading slash visible (fail-safe default)", () => {
    const result = redactWebhookPath("//webhooks/twilio/acme-support/whatsapp/mysecret");

    expect(result).not.toContain("mysecret");
    expect(result).toBe(
      `//webhooks/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}`,
    );
  });

  it("masks a percent-encoded route segment that breaks the literal match (fail-safe default)", () => {
    const result = redactWebhookPath("/webhooks/twilio/acme-support/whats%61pp/mysecret");

    expect(result).not.toContain("mysecret");
    expect(result).toBe(
      `/webhooks/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}`,
    );
  });

  it("masks a webhook path reachable under an added prefix, e.g. a future global prefix or proxy (unanchored fail-safe)", () => {
    // `WEBHOOKS_SEGMENT` is unanchored (matches `webhooks/` anywhere,
    // preceded by `/` or the string start), so a global prefix
    // (`app.setGlobalPrefix`) or a proxy forwarding under its own path
    // still gets the secret masked instead of falling through unredacted.
    const result = redactWebhookPath("/api/proxy/webhooks/twilio/acme-support/whatsapp/mysecret");

    expect(result).not.toContain("mysecret");
    expect(result).toBe(
      `/api/proxy/webhooks/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}/${REDACTED_PLACEHOLDER}`,
    );
  });

  it("is case-insensitive for the Twilio secret route (matches Express's default routing), preserving the original case of the slug", () => {
    // Pinned to an EXACT output: `not.toContain(secret)` alone would also
    // pass if the fail-safe branch (independently case-insensitive) fired
    // instead of `TWILIO_SECRET_PATH` — the two mechanisms would shadow each
    // other and neither would be individually pinned.
    const upper = redactWebhookPath("/WEBHOOKS/TWILIO/acme-support/WHATSAPP/mysecret");
    expect(upper).toBe(`/WEBHOOKS/TWILIO/acme-support/WHATSAPP/${REDACTED_PLACEHOLDER}`);

    const mixed = redactWebhookPath("/WebHooks/Twilio/acme-support/WhatsApp/mysecret");
    expect(mixed).toBe(`/WebHooks/Twilio/acme-support/WhatsApp/${REDACTED_PLACEHOLDER}`);
  });

  it("is case-insensitive for the generic token route (matches Express's default routing)", () => {
    // Pinned to an EXACT output for the same reason as above.
    const upper = redactWebhookPath("/WEBHOOKS/abcdef123456");
    expect(upper).toBe(`/webhooks/${REDACTED_PLACEHOLDER}`);

    const mixed = redactWebhookPath("/WebHooks/AbcDef123456");
    expect(mixed).toBe(`/webhooks/${REDACTED_PLACEHOLDER}`);
  });

  it("strips userinfo from the origin before echoing it into the log", () => {
    // `getFullUrl` builds the origin from the attacker-controlled
    // X-Forwarded-Host header, and that URL is logged on signature failure —
    // so a crafted `user:pass@host` authority must never reach the log line.
    const result = redactWebhookPath(
      "https://user:p4ssw0rd@host/webhooks/twilio/acme-support/whatsapp/mysecret",
    );

    expect(result).toBe(`https://host/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}`);
    expect(result).not.toContain("p4ssw0rd");
    expect(result).not.toContain("user:");
  });

  it("strips a bare userinfo (no password) from the origin", () => {
    const result = redactWebhookPath("https://user@host/webhooks/abcdef123456");

    expect(result).toBe(`https://host/webhooks/${REDACTED_PLACEHOLDER}`);
    expect(result).not.toContain("user@");
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

  it("masks the secret in a full absolute URL, keeping the scheme and host", () => {
    const result = redactWebhookPath("https://my-app.ngrok-free.dev/webhooks/twilio/acme-support/whatsapp/mysecret");

    expect(result).toBe(`https://my-app.ngrok-free.dev/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}`);
    expect(result).not.toContain("mysecret");
  });

  it("keeps a host:port pair intact when redacting a full absolute URL", () => {
    const result = redactWebhookPath("http://localhost:4000/webhooks/twilio/acme-support/whatsapp/mysecret");

    expect(result).toBe(`http://localhost:4000/webhooks/twilio/acme-support/whatsapp/${REDACTED_PLACEHOLDER}`);
  });
});
