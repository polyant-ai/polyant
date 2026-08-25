// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";

/**
 * The engine's public base URL — how an external producer (Twilio, a webhook
 * caller) must address it. Falls back to localhost so a local dev setup shows
 * a usable URL instead of an empty prefix.
 */
export function engineBaseUrl(): string {
  return config.server.baseUrl ?? `http://localhost:${config.server.port}`;
}

/** Ingestion URL of a Room event source. */
export function buildEventSourceWebhookUrl(token: string): string {
  return `${engineBaseUrl()}/webhooks/${token}`;
}

/**
 * Inbound URL to paste into the Twilio Console for a WhatsApp channel in
 * `apiKey` mode. The secret is the authentication gate — Twilio signs webhooks
 * with the account Auth Token, which this mode does not have.
 */
export function buildTwilioWhatsAppWebhookUrl(slug: string, webhookSecret: string): string {
  return `${engineBaseUrl()}/webhooks/twilio/${encodeURIComponent(slug)}/whatsapp/${encodeURIComponent(webhookSecret)}`;
}
