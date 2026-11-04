// SPDX-License-Identifier: AGPL-3.0-or-later

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";

export type McpTransport = Parameters<typeof createMCPClient>[0]["transport"];

export interface McpConnection {
  client: MCPClient;
  toolSet: Awaited<ReturnType<MCPClient["tools"]>>;
}

/**
 * The first MCP protocol version a server answers without the `initialize`
 * handshake. Versions are dates, so they compare as strings.
 */
const FIRST_STATELESS_PROTOCOL_VERSION = "2026-07-28";

/**
 * URLs of servers that answered only the `initialize` handshake. The client
 * otherwise opens every connection with a `server/discover` probe, one request
 * in series that such a server always refuses. A server leaves the set when a
 * connection without the probe fails, so one upgraded since is probed again.
 */
const legacyServers = new Set<string>();

/**
 * Connects to one MCP server and lists its tools, bounded by `timeoutMs`
 * (combined with the caller's `abortSignal` when given). A dead/slow server
 * must never block the caller — a turn (`buildMcpTools`) treats a timeout
 * exactly like any other connect failure, and the admin "test connection"
 * endpoint must not pin a Nest request and its socket open indefinitely.
 * Neither `createMCPClient` nor `client.tools()` accept a signal/timeout of
 * their own (checked against the installed `@ai-sdk/mcp` types), so the race is
 * the only clean option. A client that only resolves AFTER the race is already
 * lost (slow server, late reply) is closed as soon as it settles so it never
 * leaks past this function.
 *
 * Shared by `buildMcpTools` (mcp-tools.ts) and `testMcpConnection`
 * (mcp-test.ts) so the bound and its leak handling have ONE spelling.
 */
export async function connectWithTimeout(
  transport: McpTransport,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<McpConnection> {
  const url = "url" in transport ? transport.url : undefined;
  const knownLegacy = url !== undefined && legacyServers.has(url);
  const connect = createMCPClient({ transport, ...(knownLegacy ? { protocolVersionDiscovery: false } : {}) }).then(async (client) => {
    try {
      const toolSet = await client.tools();
      const version = client.initializeResult?.protocolVersion;
      if (url !== undefined && version !== undefined && version < FIRST_STATELESS_PROTOCOL_VERSION) legacyServers.add(url);
      return { client, toolSet };
    } catch (e) {
      await client.close().catch(() => { /* best-effort */ });
      throw e;
    }
  });
  if (knownLegacy) connect.catch(() => legacyServers.delete(url));

  const deadline = abortSignal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), abortSignal]) : AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<never>((_, reject) => {
    const fail = () => reject(deadline.reason instanceof Error ? deadline.reason : new Error(`MCP connect timed out after ${timeoutMs}ms`));
    if (deadline.aborted) fail();
    else deadline.addEventListener("abort", fail, { once: true });
  });
  // A timeout that fires AFTER `connect` already won the race (the common
  // case) must never surface as an unhandled rejection.
  timedOut.catch(() => { /* handled via the race outcome below */ });

  try {
    return await Promise.race([connect, timedOut]);
  } catch (e) {
    // `connect` can still resolve after losing the race (slow server) — never
    // leak that client. If it instead rejects, that's the same failure we
    // already surfaced (or was already closed above) — ignore it here.
    connect.then((r) => r.client.close().catch(() => { /* best-effort */ })).catch(() => { /* already handled */ });
    throw e;
  }
}
