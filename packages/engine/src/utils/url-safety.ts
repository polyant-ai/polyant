// SPDX-License-Identifier: AGPL-3.0-or-later

import { lookup } from "dns/promises";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.azure.internal",
  "metadata.azure.com",       // Azure IMDS public-facing hostname
  "metadata.oracle.internal",
  "169.254.169.254",          // Link-local IMDS (AWS/GCP/Azure IPv4)
]);

const PRIVATE_IP_RANGES = [
  // RFC 1122 / RFC 5735 — well-known private / special ranges
  /^127\./,                                                           // Loopback
  /^10\./,                                                            // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./,                                      // RFC 1918 Class B
  /^192\.168\./,                                                      // RFC 1918 Class C
  /^169\.254\./,                                                      // Link-local (APIPA / IMDS)
  /^0\.0\.0\.0$/,                                                     // Unspecified
  // RFC 6598 — Shared Address Space (100.64.0.0/10), used by ISPs/cloud internally
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // RFC 6890 — IETF Protocol Assignments (192.0.0.0/24)
  /^192\.0\.0\./,
  // RFC 5737 — Documentation / TEST-NET ranges (not routable)
  /^192\.0\.2\./,                                                     // TEST-NET-1
  /^198\.51\.100\./,                                                  // TEST-NET-2
  /^203\.0\.113\./,                                                   // TEST-NET-3
  // RFC 2544 — Benchmarking (198.18.0.0/15)
  /^198\.1[89]\./,
  // RFC 1112 — Reserved / Class E (240.0.0.0/4, includes 255.255.255.255)
  /^(24[0-9]|25[0-5])\./,
  // IPv6
  /^::$/,                                                             // Unspecified
  /^::1$/,                                                            // Loopback
  /^fd[0-9a-f]{2}:/i,                                                 // Unique local (fd::/8) — includes fd00:ec2::254 (AWS/Azure IPv6 IMDS)
  /^fe80:/i,                                                          // Link-local
  // IPv4-mapped IPv6 — block the same IPv4 ranges when expressed as ::ffff:a.b.c.d
  /^::ffff:(?:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.[02]\.|198\.51\.100\.|203\.0\.113\.)/,
];

function isPrivateIP(ip: string): boolean {
  return PRIVATE_IP_RANGES.some((pattern) => pattern.test(ip));
}

function normalizeIpLiteral(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "");
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Validate that a URL is safe to fetch (not targeting internal/private resources).
 * Returns the first safe resolved IP so callers can pin it (avoids DNS rebinding TOCTOU).
 * Throws if the URL is blocked.
 */
export async function assertSafeUrl(url: URL): Promise<ResolvedAddress> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Blocked: protocol ${url.protocol} not allowed`);
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked: hostname "${url.hostname}" not allowed`);
  }

  // Check if hostname is a literal private IP
  if (isPrivateIP(normalizeIpLiteral(hostname))) {
    throw new Error(`Blocked: private/reserved IP "${url.hostname}"`);
  }

  // DNS resolution check: hostname might resolve to a private IP.
  // Fail closed if DNS cannot be resolved so fetch() cannot bypass this guard.
  try {
    const resolved = await lookup(url.hostname, { all: true, verbatim: true });
    const addresses = Array.isArray(resolved) ? resolved : [resolved];

    if (addresses.length === 0) {
      throw new Error(`Blocked: unable to resolve hostname "${url.hostname}"`);
    }

    for (const { address } of addresses) {
      if (isPrivateIP(normalizeIpLiteral(address))) {
        throw new Error(`Blocked: "${url.hostname}" resolves to private IP ${address}`);
      }
    }

    // Return the first safe address so callers can pin it for fetch
    const first = addresses[0]!;
    return { address: first.address, family: first.family as 4 | 6 };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Blocked:")) throw err;
    // The message stays deliberately generic (it must not leak resolver
    // internals to a caller), but `cause` keeps the real reason for the logs.
    throw new Error(`Blocked: unable to resolve hostname "${url.hostname}"`, { cause: err });
  }
}

/**
 * Build a pinned DNS lookup function compatible with Node net.LookupFunction.
 * Used with undici Agent connect options to ensure the same IP validated by
 * assertSafeUrl is used for the actual connection (eliminates DNS rebinding TOCTOU).
 *
 * Supports both callback signatures:
 *  - `options.all === true` → callback(null, [{address, family}])
 *  - `options.all !== true` → callback(null, address, family)
 *
 * undici v6+ always passes `options.all = true`. Without the array branch, the
 * stack interprets the bare string as the addresses array and bails with
 * `Invalid IP address: undefined` deep in net.connect.
 */
type LookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void;
type LookupSingleCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type LookupOptions = { family?: number; all?: boolean; hints?: number };

export function pinnedLookup(
  resolved: ResolvedAddress,
): (hostname: string, options: LookupOptions, callback: LookupAllCallback | LookupSingleCallback) => void {
  return (_hostname, options, callback) => {
    if (options?.all) {
      (callback as LookupAllCallback)(null, [{ address: resolved.address, family: resolved.family }]);
    } else {
      (callback as LookupSingleCallback)(null, resolved.address, resolved.family);
    }
  };
}
