// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { isBlockedHost } from "../../../utils/url-safety.js";

/**
 * The SSRF denylist for admin-configured MCP server URLs (spec §7) is
 * `utils/url-safety.ts`'s, not a local one. This file used to re-implement it
 * and the copy was materially weaker — no cloud metadata hostnames, no CGNAT
 * (100.64.0.0/10), no 192.0.0.0/24, no TEST-NET, no 240.0.0.0/4 — so a URL
 * `httpRequest`/`curl` rejected was accepted here and then contacted on every
 * turn. Two denylists on one boundary is one denylist plus a hole.
 */

/**
 * Reject non-http(s) schemes and, in production, private/loopback/link-local
 * hosts (SSRF guard for admin-configured MCP server URLs — spec §7).
 *
 * `env` defaults to `process.env` (CONVENTION-EXCEPTION: same testable
 * env-param pattern as `getCorsOptions`/`getLogLevels` in `server/main.ts` —
 * `config.server` has no `nodeEnv` field, so this reads `NODE_ENV` directly
 * rather than inventing one; the param lets tests inject a fake env instead
 * of mutating the real `process.env` for the whole suite).
 */
export function assertSafeMcpUrl(raw: string, env: NodeJS.ProcessEnv = process.env): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequestException("Invalid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new BadRequestException("URL must be http(s)");
  }
  if (env.NODE_ENV === "production") {
    if (u.protocol !== "https:") throw new BadRequestException("HTTPS required in production");
    // IPv6 literals are bracketed in URL#hostname (e.g. "[::1]") — strip the
    // brackets before testing, or loopback/link-local/ULA IPv6 hosts never match.
    // A trailing dot is the FQDN root ("localhost." resolves like "localhost"),
    // so drop it too or the denylist is trivially sidestepped.
    const host = normalizeHost(u.hostname);
    if (isBlockedHost(host)) {
      throw new BadRequestException("Private/loopback hosts are not allowed");
    }
  }
}

/** The bracket/trailing-dot normalization `assertSafeMcpUrl` applies before the denylist. */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/**
 * The literal-URL verdict of {@link assertSafeMcpUrl} as a boolean, for a schema
 * refinement that must reject rather than throw an HTTP exception. Same
 * production-only denylist as the assert — a developer's MCP server on
 * localhost has to stay configurable, and the OAuth metadata written back by
 * the SDK goes through the very same schema.
 */
export function isSafeMcpUrl(raw: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    assertSafeMcpUrl(raw, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * The literal-URL checks of {@link assertSafeMcpUrl} PLUS a denylist check on
 * every address the hostname currently resolves to.
 *
 * Call this on the connection path, not just when the config is written.
 * `assertSafeMcpUrl` alone is a write-time check, and the URL it approved is
 * reused on every turn: an admin can save a hostname that resolves to a public
 * address and the operator of that name can later repoint it at
 * `169.254.169.254` (or any internal host), at which point every turn issues an
 * authenticated request into the private network. Resolving here closes that
 * window.
 *
 * Residual risk, accepted: this is a check-then-connect, so a name that answers
 * differently between our lookup and the HTTP client's own (classic DNS
 * rebinding with a near-zero TTL) can still slip through. Closing it fully means
 * pinning the resolved address into the socket — a custom agent/dispatcher that
 * `@ai-sdk/mcp`'s transport does not expose today.
 */
export async function assertSafeMcpUrlResolved(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  resolveHost: (host: string) => Promise<string[]> = defaultResolveHost,
): Promise<void> {
  assertSafeMcpUrl(raw, env);
  if (env.NODE_ENV !== "production") return;

  const host = normalizeHost(new URL(raw).hostname);
  // An IP literal was already checked by assertSafeMcpUrl; resolving it is a
  // pointless round-trip.
  if (isIpLiteral(host)) return;

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    // Fail closed: a name we cannot resolve is a name we cannot vouch for.
    throw new BadRequestException("Could not resolve MCP server host");
  }
  if (addresses.some((addr) => isBlockedHost(normalizeHost(addr)))) {
    throw new BadRequestException("MCP server host resolves to a private/loopback address");
  }
}

/**
 * `new URL()` already canonicalizes every `inet_aton` IPv4 spelling (decimal,
 * hex, octal, short form) to a dotted quad, so `isIP` sees the normalized host
 * and there is no alternative-notation gap to close here.
 */
function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0;
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}
