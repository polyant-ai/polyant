// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)|(^172\.(1[6-9]|2\d|3[01])\.)/i;

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
    if (PRIVATE_HOST.test(u.hostname.replace(/^\[|\]$/g, ""))) {
      throw new BadRequestException("Private/loopback hosts are not allowed");
    }
  }
}
