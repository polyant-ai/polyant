// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared HTTP utilities used by http-request and curl tools.
 * Centralizes SSRF protection, body truncation, and header picking.
 */

import { assertSafeUrl, pinnedLookup, type ResolvedAddress } from "./url-safety.js";

/**
 * Validate URL for SSRF and return an undici Agent with pinned DNS lookup.
 * Callers pass the returned dispatcher to fetch() to prevent DNS rebinding.
 */
export async function createSafeDispatcher(url: URL): Promise<{ dispatcher: unknown }> {
  const resolved = await assertSafeUrl(url);
  const { Agent } = await import("undici");
  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup(resolved) as never },
  });
  return { dispatcher };
}

/** Seam for tests: which SSRF policy decides whether the URL may be fetched. */
export interface SafeFetchDeps {
  resolve?: (url: URL) => Promise<ResolvedAddress>;
}

/**
 * Fetch a URL under SSRF protection, pinned to the address the guard validated.
 *
 * This is the ONLY place allowed to reach for undici. The dispatcher and the
 * fetch implementation MUST come from the same undici, because Node's global
 * fetch bundles its own (6.21.2 on Node 22) and undici 8 removed the legacy
 * handler wrappers it speaks: passing an undici 8 Agent to the global fetch
 * fails with `invalid onRequestStart method`, silently disabling DNS pinning
 * for every caller. Covered by the non-mocked test in safe-http.test.ts.
 *
 * `allowH2` is pinned off: undici 8 flipped its default to true, and the wire
 * protocol is not something this upgrade should change as a side effect.
 */
export async function safeFetch(
  url: URL,
  init: RequestInit = {},
  deps: SafeFetchDeps = {},
): Promise<Response> {
  const resolve = deps.resolve ?? assertSafeUrl;
  const resolved = await resolve(url);
  const { Agent } = await import("undici");
  const dispatcher = new Agent({
    allowH2: false,
    connect: { lookup: pinnedLookup(resolved) as never },
  });
  return pairedFetch(url, { ...init, dispatcher });
}

/**
 * The fetch that understands the dispatchers this module creates.
 *
 * Node's global fetch carries its own bundled undici, so a dispatcher built
 * from the npm undici only works here by accident of version alignment — and
 * undici 8 ended that alignment. Any caller that needs to pass a `dispatcher`
 * MUST route through this function rather than the global.
 */
/**
 * `RequestInit` from @types/node already declares `dispatcher`, typed against
 * the undici bundled *inside* Node. That is a different class from the npm
 * undici's `Agent`, which is why every call site used to need a
 * `@ts-expect-error`. Dropping the field and re-declaring it makes the
 * cross-package handoff explicit instead of suppressed.
 */
export type PairedRequestInit = Omit<RequestInit, "dispatcher"> & { dispatcher?: unknown };

export type PairedFetch = (url: URL | string, init?: PairedRequestInit) => Promise<Response>;

export const pairedFetch: PairedFetch = async (url, init = {}) => {
  const { fetch: undiciFetch } = await import("undici");
  return undiciFetch(url as never, init as never) as unknown as Response;
};

/**
 * Truncate a response body to a maximum number of characters.
 */
export function truncateBody(
  text: string,
  maxChars: number,
): { body: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { body: text, truncated: false };
  }
  return { body: text.slice(0, maxChars), truncated: true };
}

/**
 * Pick a subset of response headers by name (case-insensitive matching via Headers API).
 */
export function pickHeaders(
  headers: Headers,
  interesting: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of interesting) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}
