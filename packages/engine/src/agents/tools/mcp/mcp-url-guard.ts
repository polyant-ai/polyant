// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";

const IPV4_PRIVATE =
  /^(10\.|127\.|192\.168\.|169\.254\.)|^172\.(1[6-9]|2\d|3[01])\./;

/**
 * Extracts the embedded IPv4 address from an IPv4-mapped IPv6 host, in either
 * the dotted form (`::ffff:a.b.c.d`) or the hex form `new URL().hostname`
 * normalizes it to (`::ffff:7f00:1`). Returns null when `host` isn't
 * IPv4-mapped.
 */
function extractIPv4MappedAddress(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * True when `host` (already bracket-stripped + lowercased) is loopback,
 * private, link-local, unique-local, or unspecified — the SSRF denylist for
 * admin-configured MCP server URLs (spec §7). Each predicate is its own
 * named check rather than one mega-regex, so a reviewer can tell exactly
 * which class of address is being rejected.
 */
function isBlockedHost(host: string): boolean {
  // IPv4-mapped IPv6 (either textual form) — unwrap and re-check as IPv4 so
  // "[::ffff:169.254.169.254]" (or its hex-normalized twin) is caught by the
  // same rules as a bare "169.254.169.254".
  const mapped = extractIPv4MappedAddress(host);
  if (mapped) return isBlockedHost(mapped);

  if (host === "localhost") return true;
  if (host === "0.0.0.0") return true; // unspecified IPv4 — routes to loopback on Linux
  if (host === "::" || host === "0:0:0:0:0:0:0:0") return true; // unspecified IPv6
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true; // IPv6 loopback
  if (IPV4_PRIVATE.test(host)) return true;
  if (host.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // ULA fc00::/7 (first hextet fc00-fdff)

  return false;
}

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
    const host = u.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (isBlockedHost(host)) {
      throw new BadRequestException("Private/loopback hosts are not allowed");
    }
  }
}
