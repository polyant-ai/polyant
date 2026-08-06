// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool as aiTool, type Tool } from "ai";
import { z } from "zod";
import { UnauthorizedError } from "@ai-sdk/mcp";
import { connectWithTimeout } from "./mcp-connect.js";
import { config } from "../../../config.js";
import { type InstanceSlug, type InstanceUuid } from "../../../instances/identifiers.js";
import { toModelToolName } from "../registry.js";
import { listEnabledMcpServers, type McpServerRecord } from "../../../instances/mcp-servers.store.js";
import { makeMcpOAuthProvider, type McpVaultOAuthProvider } from "./mcp-oauth-provider.js";
import { mcpLog } from "./mcp-logger.js";
import { errMsg } from "../../../utils/error.js";

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

const MAX_MCP_TOOL_NAME_LENGTH = 128;

/**
 * `toModelToolName` (utils/model-tool-wire.ts) already maps every character
 * outside `[a-zA-Z0-9_-]` to `_`, which is what keeps a remote name like
 * `create.issue` or `search files` from getting the WHOLE turn rejected with a
 * provider 400 (every core tool going down with it). The one thing it does NOT
 * do is bound the length — fine for core/plugin names, which are dev-authored
 * and linted at boot, but MCP tool names arrive from a remote server, so a
 * pathologically long one is a real input. Cap it here and let the shared
 * helper own the charset rule, so there is only ONE spelling of it.
 *
 * Renaming the map KEY is safe: verified against `toolsFromDefinitions()` in
 * node_modules/@ai-sdk/mcp/dist/index.mjs — each tool's `execute` closes over the
 * ORIGINAL remote name (`name3` from the definitions loop, captured per-iteration by
 * the `for...of` block scoping) and calls `self.callTool({ name: name3, ... })`. The
 * key the SDK stores the tool under (`tools[name3]`) is never read by `execute` — so
 * whatever key WE equip it under here has no bearing on which remote tool actually
 * gets invoked.
 */
function capModelToolName(name: string): string {
  return name.length > MAX_MCP_TOOL_NAME_LENGTH ? name.slice(0, MAX_MCP_TOOL_NAME_LENGTH) : name;
}

export async function buildMcpTools(opts: {
  instanceUuid: InstanceUuid;
  instanceSlug: InstanceSlug;
  conversationId?: string;
  abortSignal?: AbortSignal;
  /**
   * Whether this call site may hand an oauth server an authorize link and persist
   * tokens/PKCE verifiers against `conversationId`. Only the conversational entry
   * point (a real user behind a stable, reused conversationId who can actually open
   * the link) sets this true. Room and webhook "supervise-direct" cycles mint a
   * FRESH conversationId every run (spec §8.3: "oauth server, ephemeral
   * conversationId (room) → Skip the server") — attempting oauth there means no one
   * is present to authorize AND every cycle leaves behind an unreusable
   * `oauth_states` row + PKCE-verifier `principal_secrets` row under a scope key
   * that's never read again. Defaults to false (safe) so a future caller that
   * forgets to set it doesn't silently regress into that pile-up.
   */
  allowOAuth?: boolean;
}): Promise<McpBuildResult> {
  const tools: Record<string, Tool> = {};
  const clients: Array<{ close: () => Promise<void> }> = [];
  const servers = await listEnabledMcpServers(opts.instanceUuid);

  for (const server of servers) {
    // The auth mode is decided ONCE here, in the branch that also enforces the
    // oauth preconditions — rather than gating above and re-testing the mode in
    // a ternary below, which read as two decisions that could drift apart.
    let provider: McpVaultOAuthProvider | undefined;
    if (server.authMode === "oauth") {
      if (!opts.allowOAuth) {
        mcpLog.warn("mcp", `server '${server.slug}' skipped: oauth not permitted on this call path (ephemeral/non-interactive conversation)`);
        continue;
      }
      // No stable conversation to persist tokens against (defensive — allowOAuth
      // callers always pass one).
      if (!opts.conversationId) continue;
      provider = makeMcpOAuthProvider({
        instanceUuid: opts.instanceUuid,
        instanceSlug: opts.instanceSlug,
        conversationId: opts.conversationId,
        serverSlug: server.slug,
        config: server.config,
      });
    }
    const allowList = (server.config as { allowList?: string[] }).allowList;
    const transport = provider
      ? { type: "http" as const, url: server.url, authProvider: provider }
      : { type: "http" as const, url: server.url, headers: staticHeaders(server) };

    try {
      const { client, toolSet } = await connectWithTimeout(transport, config.mcp.connectTimeoutMs, opts.abortSignal);
      for (const [toolName, t] of Object.entries(toolSet)) {
        if (allowList && !allowList.includes(toolName)) continue;
        const modelName = capModelToolName(toModelToolName(`mcp:${server.slug}:${toolName}`));
        if (modelName in tools) {
          mcpLog.warn("mcp", `server '${server.slug}': tool '${toolName}' sanitizes to '${modelName}', which is already equipped — skipping`);
          continue;
        }
        tools[modelName] = t as Tool;
      }
      clients.push(client);
    } catch (e) {
      if (e instanceof UnauthorizedError && provider?.pendingAuthorizeUrl) {
        tools[toModelToolName(`mcp:${server.slug}:connect`)] = connectTool(server, provider.pendingAuthorizeUrl);
      } else {
        mcpLog.warn("mcp", `server '${server.slug}' unavailable this turn: ${errMsg(e)}`);
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
