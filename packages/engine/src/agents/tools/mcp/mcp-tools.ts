// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool as aiTool, type Tool } from "ai";
import { z } from "zod";
import { UnauthorizedError } from "@ai-sdk/mcp";
import { connectWithTimeout, type McpConnection } from "./mcp-connect.js";
import { acquireMcpConnection, retireMcpConnection } from "./mcp-client-pool.js";
import { resolvePlatformSettings } from "../../../platform/platform-settings.store.js";
import { type InstanceSlug, type InstanceUuid } from "../../../instances/identifiers.js";
import { toModelToolName } from "../registry.js";
import { listEnabledMcpServers, usesSharedAccount, type McpServerRecord } from "../../../instances/mcp-servers.store.js";
import { makeMcpOAuthProvider, type McpVaultOAuthProvider } from "./mcp-oauth-provider.js";
import { McpSharedOAuthProvider } from "./mcp-shared-oauth-provider.js";
import { assertSafeMcpUrlResolved } from "./mcp-url-guard.js";
import { errMsg } from "../../../utils/error.js";
import { createLogger } from "../../../utils/create-logger.js";

const mcpLog = createLogger();

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

/**
 * Waits for a shared connect, giving up when THIS turn is aborted. The connect
 * itself goes on: other turns may be waiting on it.
 */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * A pooled connection that fails a call (server restarted, session expired,
 * network) is dropped so the next turn reconnects; the error still reaches the
 * model as before.
 */
function retireOnError(t: Tool, retire: () => void): Tool {
  const execute = t.execute;
  if (!execute) return t;
  return {
    ...t,
    execute: async (...args: Parameters<typeof execute>) => {
      try {
        return await execute(...args);
      } catch (e) {
        retire();
        throw e;
      }
    },
  } as Tool;
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
    // A shared account's tokens belong to the agent, not to this conversation,
    // so its connection is pooled like a static one.
    let pooled = true;
    if (server.authMode === "oauth") {
      if (!opts.allowOAuth) {
        mcpLog.warn("mcp", `server '${server.slug}' skipped: oauth not permitted on this call path (ephemeral/non-interactive conversation)`);
        continue;
      }
      if (usesSharedAccount(server.authMode, server.config)) {
        // Nobody in the conversation can authorize the agent's account, so a
        // server waiting for an admin offers nothing rather than a connect link.
        if (!server.sharedAccount) {
          mcpLog.warn("mcp", `server '${server.slug}' skipped: shared account not connected`);
          continue;
        }
        provider = new McpSharedOAuthProvider({
          baseUrl: (await resolvePlatformSettings()).baseUrl,
          instanceUuid: opts.instanceUuid,
          instanceSlug: opts.instanceSlug,
          serverSlug: server.slug,
          config: server.config,
          mode: { kind: "turn" },
        });
      } else {
        // No stable conversation to persist tokens against (defensive — allowOAuth
        // callers always pass one).
        if (!opts.conversationId) continue;
        pooled = false;
        provider = makeMcpOAuthProvider({
          baseUrl: (await resolvePlatformSettings()).baseUrl,
          instanceUuid: opts.instanceUuid,
          instanceSlug: opts.instanceSlug,
          conversationId: opts.conversationId,
          serverSlug: server.slug,
          config: server.config,
        });
      }
    }
    // Re-check the URL on every connect, resolved addresses included. The
    // write-time check in the controller approved this URL once; the name behind
    // it can have been repointed at an internal host since (see
    // `assertSafeMcpUrlResolved`). A rejection skips the server for this turn —
    // same degradation as an unreachable one.
    try {
      await assertSafeMcpUrlResolved(server.url);
    } catch (e) {
      mcpLog.error("mcp", `server '${server.slug}' skipped: URL rejected by the SSRF guard at connect time: ${errMsg(e)}`);
      continue;
    }

    const allowList = (server.config as { allowList?: string[] }).allowList;
    const transport = provider
      ? { type: "http" as const, url: server.url, authProvider: provider }
      : { type: "http" as const, url: server.url, headers: staticHeaders(server) };

    try {
      const { mcpConnectTimeoutMs } = await resolvePlatformSettings();
      // Per-conversation OAuth tokens belong to this conversation: that client
      // lives for the turn. Every other server shares a pooled connection across turns.
      let toolSet: McpConnection["toolSet"];
      let onCallError: (() => void) | undefined;
      if (!pooled) {
        const connection = await connectWithTimeout(transport, mcpConnectTimeoutMs, opts.abortSignal);
        toolSet = connection.toolSet;
        clients.push(connection.client);
      } else {
        const pooled = acquireMcpConnection(server, transport, mcpConnectTimeoutMs);
        toolSet = (await untilAborted(pooled, opts.abortSignal)).toolSet;
        onCallError = () => retireMcpConnection(server.id, pooled);
      }
      for (const [toolName, t] of Object.entries(toolSet)) {
        if (allowList && !allowList.includes(toolName)) continue;
        const modelName = capModelToolName(toModelToolName(`mcp:${server.slug}:${toolName}`));
        if (modelName in tools) {
          mcpLog.warn("mcp", `server '${server.slug}': tool '${toolName}' sanitizes to '${modelName}', which is already equipped — skipping`);
          continue;
        }
        tools[modelName] = onCallError ? retireOnError(t as Tool, onCallError) : (t as Tool);
      }
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
