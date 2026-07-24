// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool as aiTool, type Tool } from "ai";
import { z } from "zod";
import { createMCPClient, UnauthorizedError, type MCPClient } from "@ai-sdk/mcp";
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

export async function buildMcpTools(opts: { instanceUuid: InstanceUuid; conversationId?: string }): Promise<McpBuildResult> {
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

    let client: MCPClient | undefined;
    try {
      client = await createMCPClient({ transport });
      const toolSet = await client.tools();
      for (const [toolName, t] of Object.entries(toolSet)) {
        if (allowList && !allowList.includes(toolName)) continue;
        tools[toModelToolName(`mcp:${server.slug}:${toolName}`)] = t as Tool;
      }
      clients.push(client);
    } catch (e) {
      // if a client opened but enumeration failed, don't leak it
      if (client) {
        try {
          await client.close();
        } catch {
          /* best-effort */
        }
      }
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
