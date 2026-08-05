// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared Render.com API fetch helper with auth and rate-limit retry.
 * Pattern: mirrors hubspot-fetch.ts with exponential backoff on 429.
 *
 * Render API convention: array params use repeated keys (resource=a&resource=b),
 * not bracket notation (resource[]=a).
 */

const BASE_URL = "https://api.render.com/v1";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const TIMEOUT_MS = 60_000;

export async function renderFetch<T>(
  path: string,
  params: Record<string, string | string[]>,
  apiKey: string,
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, value);
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Render API rate limit: exhausted ${MAX_RETRIES} retries on ${path}`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const delayMs = !isNaN(parsed) && parsed > 0
        ? parsed * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Render API error (${response.status}): ${body.slice(0, 200)}`);
    }

    // Render API log messages may contain control characters that break JSON.parse.
    // Sanitize before parsing (strip C0 controls except \t, \n, \r).
    const text = await response.text();
    // eslint-disable-next-line no-control-regex -- intentionally stripping C0 controls that break JSON.parse
    const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    return JSON.parse(sanitized) as T;
  }

  throw new Error("renderFetch: unreachable");
}
