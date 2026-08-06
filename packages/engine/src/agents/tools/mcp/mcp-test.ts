// SPDX-License-Identifier: AGPL-3.0-or-later

import { UnauthorizedError } from "@ai-sdk/mcp";
import { connectWithTimeout } from "./mcp-connect.js";
import { config } from "../../../config.js";
import type { McpAuthMode } from "../../../instances/mcp-servers.store.js";

export interface McpTestOptions {
  url: string;
  authMode: McpAuthMode;
  config: Record<string, unknown>;
}

export interface McpTestResult {
  ok: boolean;
  tools?: string[];
  requiresOAuth?: boolean;
  error?: string;
}

export async function testMcpConnection(opts: McpTestOptions): Promise<McpTestResult> {
  try {
    if (opts.authMode === "oauth") {
      // Token-less connect: the admin panel just wants to confirm the URL is a
      // reachable MCP OAuth server before the user goes through the real authorize flow.
      return { ok: true, requiresOAuth: true };
    }
    const auth = (opts.config as { auth?: { type: string; token: string; headerName?: string } }).auth;
    const headers = auth ? (auth.type === "bearer" ? { Authorization: `Bearer ${auth.token}` } : { [auth.headerName!]: auth.token }) : {};
    // Bounded by the same connect timeout the pipeline uses: a URL that accepts
    // the TCP connection and never replies would otherwise pin this Nest
    // request (and its socket) open forever. `connectWithTimeout` owns closing
    // the client on the timeout and error paths.
    const { client, toolSet } = await connectWithTimeout(
      { type: "http", url: opts.url, headers },
      config.mcp.connectTimeoutMs,
    );
    try {
      return { ok: true, tools: Object.keys(toolSet) };
    } finally {
      await client.close().catch(() => {
        /* best-effort */
      });
    }
  } catch (e) {
    if (e instanceof UnauthorizedError) return { ok: true, requiresOAuth: true };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
