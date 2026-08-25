// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSafeDispatcher } from "../../../utils/safe-http.js";
import { sanitizeForLog } from "../../../utils/create-logger.js";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

/** Twilio's global Media resource host. */
const TWILIO_GLOBAL_MEDIA_HOST = "api.twilio.com";
/**
 * Suffix (leading dot included) shared by Twilio's regional API hosts, used by
 * accounts with data residency: `api.dublin.ie1.twilio.com`,
 * `api.sydney.au1.twilio.com`, and so on. An inbound `MediaUrl` on such an
 * account names the regional host, so allowlisting only the global host would
 * silently drop every attachment for those accounts.
 */
const TWILIO_API_HOST_SUFFIX = ".twilio.com";
const TWILIO_API_HOST_PREFIX = "api.";

/**
 * Is this host one Twilio serves the Media resource from?
 *
 * The rule is "starts with `api.` AND ends with `.twilio.com`", which accepts
 * the global host and every regional variant while rejecting the look-alikes
 * this check exists for:
 *   - `evil-twilio.com`        — does not end with the DOTTED suffix
 *   - `api.twilio.com.evil.test` — ends with `.evil.test`
 *   - `apifoo.twilio.com`      — does not start with the DOTTED prefix
 *
 * Anything that satisfies both ends is under Twilio's own registrable domain,
 * so it cannot be pointed at an attacker-controlled host.
 */
function isTwilioMediaHost(host: string): boolean {
  if (host === TWILIO_GLOBAL_MEDIA_HOST) return true;
  return host.startsWith(TWILIO_API_HOST_PREFIX) && host.endsWith(TWILIO_API_HOST_SUFFIX);
}

/**
 * Injectable ONLY for testability (default params): production uses the global
 * `fetch`, `createSafeDispatcher`, and a real timeout.
 */
export interface MediaFetchDeps {
  fetchFn?: typeof fetch;
  makeDispatcher?: (url: URL) => Promise<{ dispatcher: unknown }>;
  signal?: AbortSignal;
}

/**
 * Downloads a Twilio media file following redirects **manually**, keeping SSRF
 * protection on EVERY hop: each URL is re-validated and DNS re-pinned via
 * `createSafeDispatcher`. This is necessary because `api.twilio.com/.../Media/…`
 * URLs issue a 302 to a different host (CDN/S3): a dispatcher pinned to only the
 * initial host would not follow the cross-host redirect (it would connect to the
 * wrong IP → fetch failure).
 *
 * The first hop's host MUST be a Twilio API host (`isTwilioMediaHost`) before
 * the Basic `Authorization` header is ever sent — an inbound `MediaUrl0` is
 * attacker-reachable (anyone able to deliver one inbound webhook controls it),
 * so without this check a URL pointed at `https://attacker.example/x` would
 * hand the Twilio account credentials to an arbitrary host on the first hop.
 * A first hop that fails the check is refused outright (no request is sent,
 * credentialed or not) — a non-Twilio media URL in a Twilio webhook is a
 * signal, not a normal case, so failing open by fetching without the
 * credential is not an improvement.
 *
 * The `Authorization` header is sent ONLY to the original host and dropped on
 * any host change: the redirect URL is already signed, and forwarding the
 * Twilio credentials to a CDN/S3 would be a leak.
 *
 * Returns the final Response, or null if the first hop is not an allowlisted
 * Twilio host, a hop fails the SSRF check, the URL is invalid, or the redirect
 * limit is exceeded.
 */
export async function fetchMediaFollowingRedirects(
  rawUrl: string,
  basicAuth: string,
  deps: MediaFetchDeps = {},
): Promise<Response | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const makeDispatcher = deps.makeDispatcher ?? createSafeDispatcher;
  const signal = deps.signal ?? AbortSignal.timeout(TIMEOUT_MS);

  let currentUrl = rawUrl;
  let originHost: string | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target: URL;
    try {
      target = new URL(currentUrl);
    } catch {
      console.warn("[whatsapp] Media URL is not a valid URL, skipping: %s", sanitizeForLog(currentUrl));
      return null;
    }
    if (originHost === null) {
      if (!isTwilioMediaHost(target.host)) {
        console.warn(
          "[whatsapp] Media URL host is not an allowlisted Twilio host, refusing to fetch: %s",
          sanitizeForLog(currentUrl),
        );
        return null;
      }
      originHost = target.host;
    }

    let dispatcher: unknown;
    try {
      ({ dispatcher } = await makeDispatcher(target));
    } catch (err) {
      console.warn(
        "[whatsapp] Media URL failed SSRF check, skipping (%s): %s",
        sanitizeForLog(currentUrl),
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }

    // Credential sent ONLY to the original (Twilio) host. Dropped on host change.
    const headers: Record<string, string> =
      target.host === originHost ? { Authorization: `Basic ${basicAuth}` } : {};

    const res = await fetchFn(target.toString(), {
      headers,
      redirect: "manual",
      signal,
      // @ts-expect-error -- Node 22 fetch supports the undici dispatcher option
      dispatcher,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // 3xx with no Location: let the caller decide (res.ok = false)
      currentUrl = new URL(location, target).toString();
      continue;
    }
    return res;
  }

  console.warn(
    "[whatsapp] Media download exceeded %d redirects, skipping: %s",
    MAX_REDIRECTS,
    sanitizeForLog(rawUrl),
  );
  return null;
}
