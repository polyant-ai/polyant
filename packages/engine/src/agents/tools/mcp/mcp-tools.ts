// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool as aiTool, type Tool } from "ai";
import { z } from "zod";
import { createMCPClient, UnauthorizedError, type MCPClient } from "@ai-sdk/mcp";
import { config } from "../../../config.js";
import { type InstanceUuid } from "../../../instances/identifiers.js";
import { toModelToolName } from "../registry.js";
import { listEnabledMcpServers, type McpServerRecord } from "../../../instances/mcp-servers.store.js";
import { makeMcpOAuthProvider } from "./mcp-oauth-provider.js";

export interface McpBuildResult {
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}

function staticHeaders(server: McpServerRecord): Record<string, string> {
  const auth = (server.config as { auth?: { type: string; token: string; headerName?: string } }).auth;
  if (!auth) return {};
  return auth.type === "bearer" ? { Authorization: `Bearer ${auth.token}` } : { [auth.headerName!]: auth.token };
}

function connectTool(server: McpServerRecord, url: string): Tool {
  return aiTool({
    description: `Connect the ${server.name} account to enable its tools. Call this when the user asks for something that needs ${server.name} and you are not yet connected.`,
    // ponytail: no input needed — z.object({}) satisfies FlexibleSchema without fighting the SDK's Zod-first typing.
    inputSchema: z.object({}),
    execute: async () => ({ status: "action_required", message: `Open this link to connect ${server.name}, authorize, then ask again.`, url }),
  });
}

type McpTransport = Parameters<typeof createMCPClient>[0]["transport"];

/**
 * Connects to one MCP server and lists its tools, bounded by `timeoutMs`
 * (combined with the turn's `abortSignal` when given). A dead/slow server
 * must never block the whole turn — the caller treats a timeout exactly like
 * any other connect failure (log + skip; never an UnauthorizedError). Neither
 * `createMCPClient` nor `client.tools()` accept a signal/timeout of their own
 * (checked against the installed `@ai-sdk/mcp` types), so the race is the only
 * clean option. A client that only resolves AFTER the race is already lost
 * (slow server, late reply) is closed as soon as it settles so it never leaks
 * past this function.
 */
async function connectWithTimeout(
  transport: McpTransport,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<{ client: MCPClient; toolSet: Awaited<ReturnType<MCPClient["tools"]>> }> {
  const connect = createMCPClient({ transport }).then(async (client) => {
    try {
      const toolSet = await client.tools();
      return { client, toolSet };
    } catch (e) {
      await client.close().catch(() => { /* best-effort */ });
      throw e;
    }
  });

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

export async function buildMcpTools(opts: { instanceUuid: InstanceUuid; conversationId?: string; abortSignal?: AbortSignal }): Promise<McpBuildResult> {
  const tools: Record<string, Tool> = {};
  const clients: Array<{ close: () => Promise<void> }> = [];
  const servers = await listEnabledMcpServers(opts.instanceUuid);

  for (const server of servers) {
    if (server.authMode === "oauth" && !opts.conversationId) continue; // no stable conversation (room/webhook)
    const allowList = (server.config as { allowList?: string[] }).allowList;
    const provider =
      server.authMode === "oauth" && opts.conversationId
        ? makeMcpOAuthProvider({ instanceUuid: opts.instanceUuid, conversationId: opts.conversationId, serverSlug: server.slug, config: server.config })
        : undefined;
    const transport = provider
      ? { type: "http" as const, url: server.url, authProvider: provider }
      : { type: "http" as const, url: server.url, headers: staticHeaders(server) };

    try {
      const { client, toolSet } = await connectWithTimeout(transport, config.mcp.connectTimeoutMs, opts.abortSignal);
      for (const [toolName, t] of Object.entries(toolSet)) {
        if (allowList && !allowList.includes(toolName)) continue;
        tools[toModelToolName(`mcp:${server.slug}:${toolName}`)] = t as Tool;
      }
      clients.push(client);
    } catch (e) {
      if (e instanceof UnauthorizedError && provider?.pendingAuthorizeUrl) {
        tools[toModelToolName(`mcp:${server.slug}:connect`)] = connectTool(server, provider.pendingAuthorizeUrl);
      } else {
        console.warn(`[mcp] server '${server.slug}' unavailable this turn:`, e instanceof Error ? e.message : e);
      }
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
