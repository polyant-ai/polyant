// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared HubSpot fetch wrapper with retry on 429 (rate limit).
 * HubSpot free tier allows ~10 req/s; when the model fires multiple
 * tools in parallel they can easily exceed this.
 */

import type { ToolContext } from "./registry.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function hubspotFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);

    if (response.status !== 429 || attempt === MAX_RETRIES) {
      return response;
    }

    // Respect Retry-After header if present, otherwise exponential backoff
    const retryAfter = response.headers.get("Retry-After");
    const delayMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : BASE_DELAY_MS * Math.pow(2, attempt);

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Unreachable — the loop always returns — but TypeScript needs this
  throw new Error("hubspotFetch: exhausted retries");
}

/**
 * Extract and validate the HubSpot API key from tool context secrets.
 * Returns the key string on success, or an error object on failure.
 */
export function getHubSpotApiKeyOrError(ctx: ToolContext): string | { error: string } {
  const apiKey = ctx.secrets?.["hubspot_api_key"];
  if (!apiKey) return { error: "HubSpot API key not configured. Set the key in the instance settings." };
  return apiKey;
}

type HubSpotFilter = { propertyName: string; operator: string; value: string };

/**
 * Build HubSpot `filterGroups` that match a phone number on both `phone` and
 * `mobilephone` properties, trying both E.164 variants (with and without the
 * leading "+"). Returned filter groups are OR'd by HubSpot semantics.
 *
 * When the input contains ≥10 digits, also emits a fallback group on
 * `hs_searchable_calculated_phone_number` (the HubSpot-maintained digits-only
 * mirror of the phone) using `CONTAINS_TOKEN` on the last 10 digits. This
 * recovers contacts when the caller passes a phone whose formatting diverges
 * from how HubSpot stored it (extra/missing country code, embedded spaces,
 * or non-E.164 strings that HubSpot kept verbatim).
 */
export function buildPhoneFilterGroups(phone: string): Array<{ filters: HubSpotFilter[] }> {
  const withPlus = phone.replace(/[\s().-]/g, "");
  const withoutPlus = withPlus.replace(/^\+/, "");
  const groups: Array<{ filters: HubSpotFilter[] }> = [
    { filters: [{ propertyName: "phone", operator: "EQ", value: withPlus }] },
    { filters: [{ propertyName: "mobilephone", operator: "EQ", value: withPlus }] },
  ];
  if (withoutPlus !== withPlus) {
    groups.push({ filters: [{ propertyName: "phone", operator: "EQ", value: withoutPlus }] });
    groups.push({ filters: [{ propertyName: "mobilephone", operator: "EQ", value: withoutPlus }] });
  }
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 10) {
    groups.push({
      filters: [
        {
          propertyName: "hs_searchable_calculated_phone_number",
          operator: "CONTAINS_TOKEN",
          value: digits.slice(-10),
        },
      ],
    });
  }
  return groups;
}

/**
 * Resolve a HubSpot contact id from a phone number. Returns the first matching
 * contact id, or null if no contact matches.
 */
export async function resolveContactIdFromPhone(
  apiKey: string,
  phone: string,
): Promise<string | null> {
  const response = await hubspotFetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        filterGroups: buildPhoneFilterGroups(phone),
        properties: ["hs_object_id"],
        limit: 1,
      }),
    },
  );

  if (!response.ok) return null;
  const data = (await response.json()) as { results?: Array<{ id: string }> };
  return data.results?.[0]?.id ?? null;
}

/**
 * Resolve a HubSpot owner ID from an email address.
 *
 * Queries the HubSpot Owners API (/crm/v3/owners?email=...) and returns the
 * first matching owner's numeric `id` as a string, or `null` if no owner is
 * found / the API call fails. Used by tools that accept `ownerEmail` and
 * need to map it to `hubspot_owner_id` before writing to objects (tasks,
 * deals, etc.).
 *
 * The HubSpot API filters case-insensitively on email; results array is
 * normally length 0 or 1.
 */
export async function resolveOwnerIdFromEmail(
  apiKey: string,
  email: string,
): Promise<string | null> {
  const url = `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`;
  const response = await hubspotFetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) return null;
  const data = (await response.json()) as { results?: Array<{ id: string }> };
  return data.results?.[0]?.id ?? null;
}

/**
 * Standard HubSpot association type IDs.
 * @see https://developers.hubspot.com/docs/api/crm/associations
 */
export const HUBSPOT_ASSOCIATION_TYPES = {
  contactToCompany: "1",
  dealToContact: "3",
  dealToCompany: "5",
  ticketToContact: "16",
  noteToTicket: "18",
  noteToCompany: "190",
  emailToContact: "198",
  meetingToContact: "200",
  noteToContact: "202",
  taskToContact: "204",
  noteToDeal: "214",
} as const;
