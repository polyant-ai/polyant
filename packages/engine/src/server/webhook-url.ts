// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolvePlatformSettings } from "../platform/platform-settings.store.js";

/**
 * The engine's public base URL — how an external producer (Twilio, a webhook
 * caller) must address it.
 *
 * It is the platform setting when one is stored, `BASE_URL` otherwise, and
 * `http://localhost:<port>` when neither is set, so a local dev setup shows a
 * usable URL instead of an empty prefix. Asynchronous because the first of those
 * is a row: every caller builds a URL to hand to a person or a provider, inside
 * a request that is already waiting on the database.
 */
export async function engineBaseUrl(): Promise<string> {
  const { baseUrl } = await resolvePlatformSettings();
  return baseUrl;
}

/** Ingestion URL of a Room event source. */
export async function buildEventSourceWebhookUrl(token: string): Promise<string> {
  return `${await engineBaseUrl()}/webhooks/${token}`;
}

/**
 * Inbound URL to paste into the Twilio Console for a WhatsApp channel in
 * `apiKey` mode. The secret is the authentication gate — Twilio signs webhooks
 * with the account Auth Token, which this mode does not have.
 */
export async function buildTwilioWhatsAppWebhookUrl(slug: string, webhookSecret: string): Promise<string> {
  return `${await engineBaseUrl()}/webhooks/twilio/${encodeURIComponent(slug)}/whatsapp/${encodeURIComponent(webhookSecret)}`;
}

/** Public Slack Events API endpoint; the signing secret authenticates inbound requests. */
export async function buildSlackWebhookUrl(slug: string): Promise<string> {
  return `${await engineBaseUrl()}/webhooks/slack/${encodeURIComponent(slug)}`;
}
