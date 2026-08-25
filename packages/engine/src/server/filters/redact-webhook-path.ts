// SPDX-License-Identifier: AGPL-3.0-or-later

/** Placeholder that replaces a masked credential segment in a logged path. */
export const REDACTED_PLACEHOLDER = "<redacted>";

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

// Fail-safe: any other path shape under `/webhooks/` (including a doubled
// slash, a leading extra slash, or a percent-encoded segment that breaks the
// literal-text match above) is unrecognised, so it might still be carrying a
// credential in a shape we didn't anticipate. Mask everything after the
// `/webhooks/` prefix rather than let it through — the helper's contract is
// "safe to log", not "matches a known shape".
const WEBHOOKS_PREFIX = /^\/+webhooks\//i;

// Matches a leading `scheme://host[:port]` so a full absolute URL (as built
// by `TwilioWebhookController.getFullUrl` from x-forwarded-host / the
// request's own host) can be redacted too, not just a bare path.
const ORIGIN_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

/**
 * Mask the credential-bearing segment of an inbound webhook path (or full
 * URL) so it is safe to write to plaintext log files, while keeping the rest
 * (scheme/host, instance slug, route shape) intact and useful for debugging.
 *
 * The query string is always dropped — a secret must not survive there
 * either, and no caller of this function needs it. Matching is
 * case-insensitive because Express routing is case-insensitive by default.
 * Fail-safe default: any path under `/webhooks/` that matches none of the
 * known credential-bearing or known credential-free shapes has everything
 * after the `/webhooks/` prefix masked, since an unrecognised shape might
 * still be carrying a credential. Paths outside `/webhooks/` are returned
 * unchanged (minus the query string).
 */
export function redactWebhookPath(url: string): string {
  const originMatch = url.match(ORIGIN_PREFIX);
  const origin = originMatch ? originMatch[0] : "";
  const rest = origin ? url.slice(origin.length) : url;

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
    return `${origin}/webhooks/${REDACTED_PLACEHOLDER}${trailingSlash}`;
  }

  if (TWILIO_AUTH_TOKEN_PATH.test(pathname)) {
    return `${origin}${pathname}`;
  }

  if (WEBHOOKS_PREFIX.test(pathname)) {
    return `${origin}/webhooks/${REDACTED_PLACEHOLDER}`;
  }

  return `${origin}${pathname}`;
}
