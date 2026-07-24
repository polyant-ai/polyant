// SPDX-License-Identifier: AGPL-3.0-or-later

import { createMCPClient, UnauthorizedError } from "@ai-sdk/mcp";
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
    const client = await createMCPClient({ transport: { type: "http", url: opts.url, headers } });
    const toolSet = await client.tools();
    await client.close();
    return { ok: true, tools: Object.keys(toolSet) };
  } catch (e) {
    if (e instanceof UnauthorizedError) return { ok: true, requiresOAuth: true };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
