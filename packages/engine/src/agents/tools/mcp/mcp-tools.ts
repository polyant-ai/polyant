// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool as aiTool, type Tool } from "ai";
import { z } from "zod";
import { UnauthorizedError } from "@ai-sdk/mcp";
import { connectWithTimeout, type McpConnection } from "./mcp-connect.js";
import { acquireMcpConnection, retireMcpConnection } from "./mcp-client-pool.js";
import { resolvePlatformSettings } from "../../../platform/platform-settings.store.js";
import { createHash } from "node:crypto";
import { DEFAULT_PROVIDER } from "../../../ai-gateway/model-catalog.js";
import { wireDialectFor } from "../../../ai-gateway/config.js";
import { type InstanceSlug, type InstanceUuid } from "../../../instances/identifiers.js";
import { resolveInstanceUuid } from "../../../instances/instance-meta.js";
import { findInstanceBySlug } from "../../../instances/store.js";
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

const DEFAULT_MAX_MCP_TOOL_NAME_LENGTH = 128;

/**
 * Bedrock Converse caps `ToolSpecification.name` at 64 and rejects the whole
 * call over it (#424). Anthropic documents 128 (`^[a-zA-Z0-9_-]{1,128}$`) and
 * OpenAI enforces 128 (129 is rejected with `string_above_max_length`).
 */
const BEDROCK_MAX_MCP_TOOL_NAME_LENGTH = 64;

const CAPPED_NAME_HASH_LENGTH = 8;

/** A long slug is shortened down to this many characters before the tool part is. */
const CAPPED_SLUG_MIN_LENGTH = 16;

/**
 * The longest equipped MCP tool name the agent's provider accepts. Keyed on the
 * catalog's `wireDialect`, not on the provider name, like the rest of the
 * gateway: a provider that speaks Converse under another name gets 64 too.
 */
export function maxMcpToolNameLength(provider: string | undefined): number {
  return wireDialectFor(provider ?? DEFAULT_PROVIDER) === "bedrock"
    ? BEDROCK_MAX_MCP_TOOL_NAME_LENGTH
    : DEFAULT_MAX_MCP_TOOL_NAME_LENGTH;
}

/**
 * `toModelToolName` (utils/model-tool-wire.ts) already maps every character
 * outside `[a-zA-Z0-9_-]` to `_`, which is what keeps a remote name like
 * `create.issue` or `search files` from getting the WHOLE turn rejected with a
 * provider 400 (every core tool going down with it). The one thing it does NOT
 * do is bound the length — fine for core/plugin names, which are dev-authored
 * and linted at boot, but MCP tool names arrive from a remote server, so a long
 * one is a real input. Cap it here and let the shared helper own the charset
 * rule, so there is only ONE spelling of it.
 *
 * A name within the cap is `mcp__<slug>__<tool>`, unchanged. Over the cap, the
 * slug is shortened first (down to 16 characters), then the tool part, and the
 * key ends with `_` plus the first 8 hex digits of the SHA-256 of the full
 * mapped name. So the model still sees what the tool is called even under a
 * long slug, two long names that share a prefix stay two keys (a plain slice
 * would collapse them and the already-equipped guard would drop the second with
 * only a log line), and the key is the same on every turn.
 *
 * Renaming the map KEY is safe: verified against `toolsFromDefinitions()` in
 * node_modules/@ai-sdk/mcp/dist/index.js (2.0.86) — each tool's `execute` closes
 * over the ORIGINAL remote `name` from the definitions loop (captured
 * per-iteration by the `for...of` block scoping) and calls
 * `self.callTool({ name, ... })`. The key the SDK stores the tool under is never
 * read by `execute` — so whatever key WE equip it under here has no bearing on
 * which remote tool actually gets invoked.
 */
export function mcpModelToolName(slug: string, toolName: string, max: number): string {
  const full = toModelToolName(`mcp:${slug}:${toolName}`);
  if (full.length <= max) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, CAPPED_NAME_HASH_LENGTH);
  const slugPart = toModelToolName(slug);
  const toolPart = toModelToolName(toolName);
  // What is left for the two parts once `mcp__`, the `__` between them and `_<hash>` are in.
  const room = max - "mcp__".length - "__".length - CAPPED_NAME_HASH_LENGTH - 1;
  const slugKept = slugPart.slice(0, Math.max(CAPPED_SLUG_MIN_LENGTH, room - toolPart.length));
  return `mcp__${slugKept}__${toolPart.slice(0, room - slugKept.length)}_${hash}`;
}

interface McpTurnOptions {
  instanceUuid: InstanceUuid;
  instanceSlug: InstanceSlug;
  conversationId?: string;
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
}

/** How a turn reaches one server, or why it skips it (`reason` is logged when set). */
type ServerConnection =
  | { skip: true; reason?: string }
  | {
      skip?: false;
      /** Shared across turns through the pool; false for a per-conversation OAuth client. */
      pooled: boolean;
      provider?: McpVaultOAuthProvider;
      connect: (abortSignal?: AbortSignal) => Promise<McpConnection>;
    };

async function serverConnection(server: McpServerRecord, opts: McpTurnOptions): Promise<ServerConnection> {
  // The auth mode is decided ONCE here, in the branch that also enforces the
  // oauth preconditions — rather than gating above and re-testing the mode in
  // a ternary below, which read as two decisions that could drift apart.
  let provider: McpVaultOAuthProvider | undefined;
  // A shared account's tokens belong to the agent, not to this conversation,
  // so its connection is pooled like a static one.
  let pooled = true;
  if (server.authMode === "oauth") {
    if (!opts.allowOAuth) {
      return { skip: true, reason: "oauth not permitted on this call path (ephemeral/non-interactive conversation)" };
    }
    if (usesSharedAccount(server.authMode, server.config)) {
      // Nobody in the conversation can authorize the agent's account, so a
      // server waiting for an admin offers nothing rather than a connect link.
      if (!server.sharedAccount) return { skip: true, reason: "shared account not connected" };
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
      if (!opts.conversationId) return { skip: true };
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
  const transport = provider
    ? { type: "http" as const, url: server.url, authProvider: provider }
    : { type: "http" as const, url: server.url, headers: staticHeaders(server) };
  const { mcpConnectTimeoutMs } = await resolvePlatformSettings();
  // Re-check the URL on every connect, resolved addresses included. The
  // write-time check in the controller approved this URL once; the name
  // behind it can have been repointed at an internal host since (see
  // `assertSafeMcpUrlResolved`). A rejection skips the server — same
  // degradation as an unreachable one. A turn served by a pooled connection
  // checks before it leases one (`buildMcpTools`).
  const connect = async (abortSignal?: AbortSignal) => {
    try {
      await assertSafeMcpUrlResolved(server.url);
    } catch (e) {
      mcpLog.error("mcp", `server '${server.slug}': URL rejected by the SSRF guard at connect time: ${errMsg(e)}`);
      throw e;
    }
    return connectWithTimeout(transport, mcpConnectTimeoutMs, abortSignal);
  };
  return { pooled, provider, connect };
}

/**
 * Starts a turn's MCP work before the turn needs it: reads the agent's enabled
 * servers and starts opening their pooled connections, waiting for neither. The
 * context reads and the pre-model hooks run meanwhile. Pass the result to
 * `buildMcpTools` as `servers`: the turn then reads the list once and leases the
 * connections already in flight. A turn that stops before the model call leaves
 * them in the pool for the next turn, as any turn does; per-conversation OAuth
 * clients are not opened here, since only the turn that uses one can close it.
 */
export function startMcpConnections(opts: Omit<McpTurnOptions, "instanceUuid">): Promise<McpServerRecord[]> {
  const started = (async () => {
    const instanceUuid =
      (await resolveInstanceUuid(opts.instanceSlug)) ?? (await findInstanceBySlug(opts.instanceSlug))?.id;
    if (!instanceUuid) return { instanceUuid, servers: [] };
    return { instanceUuid, servers: await listEnabledMcpServers(instanceUuid) };
  })();
  void started
    .then(async ({ instanceUuid, servers }) => {
      if (!instanceUuid) return;
      for (const server of servers) {
        const connection = await serverConnection(server, { ...opts, instanceUuid });
        if (connection.skip || !connection.pooled) continue;
        // A lease taken and given back at once: the connection stays pooled.
        acquireMcpConnection(server, () => connection.connect()).release();
      }
    })
    // The turn meets any failure again when it builds its tools.
    .catch(() => { /* best-effort */ });
  const servers = started.then((s) => s.servers);
  // A turn that stops before the model call never reads the list: its failure
  // must not surface as an unhandled rejection. `buildMcpTools` still sees it.
  servers.catch(() => { /* handled where it is awaited */ });
  return servers;
}

export async function buildMcpTools(opts: McpTurnOptions & {
  abortSignal?: AbortSignal;
  /** The server list from `startMcpConnections`; read here when absent. */
  servers?: Promise<McpServerRecord[]>;
  /**
   * The provider the agent runs on (`undefined` = the gateway default). It
   * sets the longest tool name to equip: Bedrock rejects names over 64.
   */
  provider?: string;
}): Promise<McpBuildResult> {
  const maxNameLength = maxMcpToolNameLength(opts.provider);
  const tools: Record<string, Tool> = {};
  const clients: Array<{ close: () => Promise<void> }> = [];
  const leases: Array<{ release: () => void }> = [];
  const servers = await (opts.servers ?? listEnabledMcpServers(opts.instanceUuid));

  for (const server of servers) {
    let provider: McpVaultOAuthProvider | undefined;
    try {
      const connection = await serverConnection(server, opts);
      if (connection.skip) {
        if (connection.reason) mcpLog.warn("mcp", `server '${server.slug}' skipped: ${connection.reason}`);
        continue;
      }
      provider = connection.provider;
      const allowList = (server.config as { allowList?: string[] }).allowList;
      // Per-conversation OAuth tokens belong to this conversation: that client
      // lives for the turn. Every other server shares a pooled connection across turns.
      let toolSet: McpConnection["toolSet"];
      let onCallError: (() => void) | undefined;
      if (!connection.pooled) {
        const opened = await connection.connect(opts.abortSignal);
        toolSet = opened.toolSet;
        clients.push(opened.client);
      } else {
        // A pooled connection sends every call to the URL's name as it resolves
        // now: each turn re-checks it, and a rejection drops the connection.
        try {
          await assertSafeMcpUrlResolved(server.url);
        } catch (e) {
          retireMcpConnection(server.id);
          throw e;
        }
        const lease = acquireMcpConnection(server, () => connection.connect());
        leases.push(lease);
        toolSet = (await untilAborted(lease.connection, opts.abortSignal)).toolSet;
        onCallError = lease.retire;
      }
      for (const [toolName, t] of Object.entries(toolSet)) {
        if (allowList && !allowList.includes(toolName)) continue;
        const modelName = mcpModelToolName(server.slug, toolName, maxNameLength);
        if (modelName in tools) {
          mcpLog.warn("mcp", `server '${server.slug}': tool '${toolName}' sanitizes to '${modelName}', which is already equipped — skipping`);
          continue;
        }
        if (modelName !== toModelToolName(`mcp:${server.slug}:${toolName}`)) {
          mcpLog.debug("mcp", `server '${server.slug}': tool '${toolName}' equipped as '${modelName}' (provider limit ${maxNameLength})`);
        }
        tools[modelName] = onCallError ? retireOnError(t as Tool, onCallError) : (t as Tool);
      }
    } catch (e) {
      if (e instanceof UnauthorizedError && provider?.pendingAuthorizeUrl) {
        tools[mcpModelToolName(server.slug, "connect", maxNameLength)] = connectTool(server, provider.pendingAuthorizeUrl);
      } else {
        mcpLog.warn("mcp", `server '${server.slug}' unavailable this turn: ${errMsg(e)}`);
      }
    }
  }

  return {
    tools,
    close: async () => {
      for (const lease of leases) lease.release();
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
