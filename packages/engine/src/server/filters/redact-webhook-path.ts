// SPDX-License-Identifier: AGPL-3.0-or-later

/** Placeholder that replaces a masked credential segment in a logged path. */
export const REDACTED_PLACEHOLDER = "<redacted>";

// `/webhooks/twilio/<slug>/whatsapp/<secret>` — the API-Key-mode WhatsApp
// inbound route (`TwilioWebhookController.handleWhatsAppWebhookWithSecret`).
// The instance slug is not a secret and is the useful debugging identifier,
// so only the trailing path secret is masked.
const TWILIO_SECRET_PATH = /^(\/webhooks\/twilio\/[^/]+\/whatsapp)\/[^/]+(\/?)$/;

// `/webhooks/<token>` — the Room event-source webhook route
// (`WebhookController.receiveEvent`). The token is the sole credential for
// that route and must be masked in full.
const GENERIC_WEBHOOK_TOKEN_PATH = /^\/webhooks\/[^/]+(\/?)$/;

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
 * either, and no caller of this function needs it. Paths that do not match
 * a known webhook shape are returned unchanged (minus the query string).
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

  return `${origin}${pathname}`;
}
