// SPDX-License-Identifier: AGPL-3.0-or-later

/** Placeholder that replaces a masked credential segment in a logged path. */
export const REDACTED_PLACEHOLDER = "<redacted>";

/** The path prefix every webhook route lives under. */
const WEBHOOKS_PREFIX_TEXT = "/webhooks/";

// `/webhooks/twilio/<slug>/whatsapp/<secret>` — the API-Key-mode WhatsApp
// inbound route (`TwilioWebhookController.handleWhatsAppWebhookWithSecret`).
// The instance slug is not a secret and is the useful debugging identifier,
// so only the trailing path secret is masked. Case-insensitive: Express
// routing is case-insensitive by default, so a mixed-case URL (e.g. pasted
// into the Twilio Console) still reaches the real handler and must still be
// recognised here.
const TWILIO_SECRET_PATH = /^(\/webhooks\/twilio\/[^/]+\/whatsapp)\/[^/]+(\/?)$/i;

// `/webhooks/<token>` — the Room event-source webhook route
// (`WebhookController.receiveEvent`). The token is the sole credential for
// that route and must be masked in full.
const GENERIC_WEBHOOK_TOKEN_PATH = /^\/webhooks\/[^/]+(\/?)$/i;

// `/webhooks/twilio/<slug>/whatsapp` — the Auth-Token-mode Twilio route with
// no trailing secret segment (`TwilioWebhookController.handleWhatsAppWebhook`).
// Recognised explicitly so it is returned unchanged instead of falling into
// the fail-safe branch below, which would otherwise mask a path that never
// carried a credential in the first place.
const TWILIO_AUTH_TOKEN_PATH = /^\/webhooks\/twilio\/[^/]+\/whatsapp\/?$/i;

// Fail-safe: locates the `webhooks/` path segment ANYWHERE in the pathname
// (not just at the start), so a future global prefix (`app.setGlobalPrefix`,
// or a proxy forwarding under its own path, e.g. `/api/proxy/webhooks/...`)
// still gets masked instead of falling through unmasked. Matches on a `/`
// or the start of the string immediately before `webhooks/` so it never
// matches a substring inside an unrelated segment name (e.g. `/my-webhooks/`).
const WEBHOOKS_SEGMENT = /(^|\/)webhooks\//i;

// Matches a leading `scheme://authority` so a full absolute URL (as built by
// `TwilioWebhookController.getFullUrl` from x-forwarded-host / the request's
// own host) can be redacted too, not just a bare path.
const ORIGIN_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

/**
 * Strip a `user:pass@` (or bare `user@`) userinfo prefix from an origin's
 * authority before it is echoed into a log line. `getFullUrl` builds the
 * origin from the attacker-controlled `X-Forwarded-Host` header, so a
 * crafted value like `user:p4ssw0rd@host` would otherwise carry credentials
 * straight into the log.
 */
function stripUserinfo(origin: string): string {
  const schemeEnd = origin.indexOf("://");
  if (schemeEnd === -1) return origin;

  const scheme = origin.slice(0, schemeEnd + 3);
  const authority = origin.slice(schemeEnd + 3);
  const atIndex = authority.lastIndexOf("@");
  return atIndex === -1 ? origin : `${scheme}${authority.slice(atIndex + 1)}`;
}

/**
 * Mask every path segment after a `webhooks/` segment individually, keeping
 * the segment COUNT (including empty segments from a doubled slash) intact.
 * A mistyped webhook URL (wrong slug, misspelled route segment, an extra
 * segment, a doubled slash) is the most common real-world incident, and the
 * segment count is exactly the detail an operator needs to diagnose it — so
 * the fail-safe must not collapse the whole tail into one opaque token.
 */
function maskSegmentsAfterWebhooksPrefix(pathname: string): string {
  const match = pathname.match(WEBHOOKS_SEGMENT);
  if (!match) return pathname;

  const matchEnd = (match.index ?? 0) + match[0].length;
  const kept = pathname.slice(0, matchEnd);
  const tail = pathname.slice(matchEnd);

  const maskedTail = tail
    .split("/")
    .map((segment) => (segment === "" ? "" : REDACTED_PLACEHOLDER))
    .join("/");

  return `${kept}${maskedTail}`;
}

/**
 * Mask the credential-bearing segment of an inbound webhook path (or full
 * URL) so it is safe to write to plaintext log files, while keeping the rest
 * (scheme/host, instance slug, route shape) intact and useful for debugging.
 *
 * The query string is always dropped — a secret must not survive there
 * either, and no caller of this function needs it. Matching is
 * case-insensitive because Express routing is case-insensitive by default.
 * Fail-safe default: any path containing a `webhooks/` segment that matches
 * none of the known credential-bearing or known credential-free shapes has
 * every segment after it masked individually (segment count preserved),
 * since an unrecognised shape might still be carrying a credential. Paths
 * with no `webhooks/` segment at all are returned unchanged (minus the query
 * string and any userinfo in the origin).
 */
export function redactWebhookPath(url: string): string {
  const originMatch = url.match(ORIGIN_PREFIX);
  const originLength = originMatch ? originMatch[0].length : 0;
  const origin = originMatch ? stripUserinfo(originMatch[0]) : "";
  const rest = originMatch ? url.slice(originLength) : url;

  const queryIndex = rest.indexOf("?");
  const pathname = queryIndex === -1 ? rest : rest.slice(0, queryIndex);

  const twilioMatch = pathname.match(TWILIO_SECRET_PATH);
  if (twilioMatch) {
    const [, prefix, trailingSlash] = twilioMatch;
    return `${origin}${prefix}/${REDACTED_PLACEHOLDER}${trailingSlash}`;
  }

  const genericMatch = pathname.match(GENERIC_WEBHOOK_TOKEN_PATH);
  if (genericMatch) {
    const [, trailingSlash] = genericMatch;
    return `${origin}${WEBHOOKS_PREFIX_TEXT}${REDACTED_PLACEHOLDER}${trailingSlash}`;
  }

  if (TWILIO_AUTH_TOKEN_PATH.test(pathname)) {
    return `${origin}${pathname}`;
  }

  if (WEBHOOKS_SEGMENT.test(pathname)) {
    return `${origin}${maskSegmentsAfterWebhooksPrefix(pathname)}`;
  }

  return `${origin}${pathname}`;
}
