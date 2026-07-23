# MCP Client Support (remote, per-instance) — Design

- **Date:** 2026-07-20
- **Status:** Approved (design)
- **Scope:** V1 — consume tools from external MCP servers over remote HTTP transport, with static per-instance auth.

## Context

Polyant agents can only use tools that live in the engine (core `*.tool.ts`, plugins, and virtual `agent:`/`spawnTask` tools). `ROADMAP.md` lists "First-party MCP server support for tools". This spec covers the **client** direction: an instance connects to external Model Context Protocol (MCP) servers and exposes their tools to the supervisor as if they were native tools.

There is no MCP code in the repo today — this is greenfield. The design deliberately reuses two existing seams:

1. **`instance_channels`** (encrypted per-instance config blob) as the template for MCP server config storage.
2. The **virtual-tool synthesis** in `buildTools` (`supervisor/index.ts`, the `agent:{slug}` block) as the template for turning a remote tool list into live AI SDK `Tool`s at runtime — bypassing the static registry and the `instance_tools` catalog.

## Decisions

| Axis | Decision |
|------|----------|
| Direction | **Client** — agents consume external MCP tools |
| Transport | **Remote HTTP only** (Streamable HTTP + SSE). No stdio, no subprocess, no extra container binaries |
| Auth (V1) | **Static per-instance** — bearer or custom header, credentials encrypted per instance |
| Auth (future) | `authMode` column + AI SDK `authProvider` hook reserved for per-user / OAuth 2.1 (V2) |
| Enablement | **Server-level** on/off. No per-tool catalog sync, no drift handling. Optional per-server allow-list |
| Library | **`@ai-sdk/mcp@^1.0` `createMCPClient`** (first-party Vercel; the 1.x line matches `ai@6`'s `@ai-sdk/provider@3.x` — 2.x pulls provider@4 and breaks typecheck) — not `@modelcontextprotocol/sdk` directly |
| Connection lifecycle | **Per-turn** — open in `buildTools`, close in a `finally` at the end of `supervise`/`superviseStream` and on abort |

### Non-goals (V2+)

- Per-user credentials and OAuth 2.1 + PKCE login flow (the `authMode` field and `authProvider` hook are the reserved extension points).
- Per-tool enablement granularity / catalog sync.
- Persistent connection pooling and tool-list caching.
- MCP **server** direction (exposing Polyant tools to external clients).

## Why `@ai-sdk/mcp` (AI SDK v6)

Verified against AI SDK v6 docs. `createMCPClient({ transport })` supports:

```ts
import { createMCPClient } from "@ai-sdk/mcp";

const client = await createMCPClient({
  transport: {
    type: "http",            // or "sse"
    url: "https://server.example.com/mcp",
    headers: { Authorization: "Bearer <token>" }, // V1 static auth
    // authProvider: <OAuthClientProvider>,        // V2 hook — reserved
  },
});
const toolSet = await client.tools(); // Record<name, Tool> already in AI SDK shape
// ... use in generateText/streamText ...
await client.close();
```

`client.tools()` returns tools whose `inputSchema` is JSON Schema and whose `execute` uses the connected client — the exact shape `buildTool` already produces, so no Zod round-trip and no bespoke transport code. The `authProvider` field is the built-in seam for V2 OAuth.

**Implementation note (verified 2026-07-23):** pin **`@ai-sdk/mcp@^1.0`** (latest 1.x = `1.0.64`), NOT the dist-tag `latest` (2.x). Same discipline as the `@ai-sdk/openai-compatible` pin — a mismatched `@ai-sdk/provider` major breaks typecheck. Concretely: `ai@6.0.194` resolves `@ai-sdk/provider@3.0.10`; `@ai-sdk/mcp@1.x` depends on `@ai-sdk/provider@3.x` (aligned ✓), while `@ai-sdk/mcp@2.x` depends on `@ai-sdk/provider@4.x` (`LanguageModelV4` — `"v4" not assignable to "v2/v3"`, the exact break CLAUDE.md documents for openai-compatible). `ai@6` bundles NO MCP client of its own, so the separate package is required. `createMCPClient` (aliased `experimental_createMCPClient`) and the V2 OAuth seam (`OAuthClientProvider`, `auth`, `UnauthorizedError`) are all exported by the 1.x line. Re-align the pin on every `ai` bump (verify `ai`'s `@ai-sdk/provider` major, then pick the `@ai-sdk/mcp` line that matches it).

## Architecture

### 1. Storage — `instance_mcp_servers`

New table + store, mirroring `channels.schema.ts` / `channels.store.ts`:

```
instance_mcp_servers (
  id          uuid pk default random,
  instanceId  uuid not null FK -> instances(id) on delete cascade,
  slug        varchar(50)  not null,   -- server namespace, e.g. "github"
  name        varchar(100) not null,   -- UI label
  url         text not null,           -- https endpoint
  authMode    varchar(20) not null default 'static',  -- EXTENSIBLE: 'static' | (future) 'per-user' | 'oauth'
  enabled     boolean not null default true,
  config      text not null,           -- encrypt(JSON.stringify({ auth, allowList? }))
  createdAt   timestamptz not null default now(),
  updatedAt   timestamptz not null default now(),
  unique (instanceId, slug)
)
```

- `config` is the encrypted JSON blob (same `encrypt`/`safeDecryptConfig` helpers as channels). Decrypted shape:
  ```ts
  {
    auth: { type: "bearer"; token: string }
        | { type: "header"; headerName: string; token: string },
    allowList?: string[]   // optional tool-name filter; empty/absent = all tools
  }
  ```
- Credentials live **inside** the encrypted `config`, not in `instance_secrets` (matches the channels pattern; avoids dynamic secret-key management).
- `authMode` is a real column (not buried in `config`) so the future per-user/OAuth path is an additive migration, not a destructive one.
- Store surface mirrors channels: `setMcpServer`, `getMcpServer`, `listMcpServers(instanceUuid)`, `listEnabledMcpServers(instanceUuid)`, `deleteMcpServer`. Store functions take `InstanceUuid` (uuid-FK table, per the branded-identifier convention). Per-server config validated with a Zod schema before encrypt.

### 2. Runtime — synthesis in `buildTools` + per-turn lifecycle

In `supervisor/index.ts`, a new block right after the `agent:{slug}` synthesis (~`index.ts:317`):

```
for each server in listEnabledMcpServers(instanceUuid):
    client = await createMCPClient({ transport: httpTransport(server) })  // headers from decrypted config
    toolSet = await client.tools()
    for [toolName, tool] of toolSet:
        if allowList and toolName not in allowList: continue
        key = `mcp:${server.slug}:${toolName}`                 // internal name
        tools[toModelToolName(key)] = wrapToolWithAudit(key, tool, ...)  // -> mcp__server__tool
    openClients.push(client)
```

- `toModelToolName` already maps `:` -> `__`, so the model sees `mcp__github__create_issue`. Server slug in the namespace resolves cross-server name collisions.
- Each MCP tool is wrapped with the existing `wrapToolWithAudit` for timing/trace/`replyHandled` parity with every other tool.
- **Lifecycle:** the clients opened this turn are collected into a handle returned alongside the tools. `supervise` / `superviseStream` close them in a `finally` after the LLM + tool loop completes, and on `AbortSignal` abort — consistent with the rest of the pipeline (aborted turns leave no dangling connections).
- `// ponytail: connect + listTools per server per turn; if latency matters -> TTL tool-list cache + connection pool` — named ceiling + upgrade path.

### 3. Enablement — server-level, bypass `instance_tools`

- The enablement flag is the `enabled` column on the server row.
- MCP tools **bypass** `getEnabledToolNames` / `instance_tools` entirely, exactly like harness and `agent:` tools. No rows in the `tools` catalog, no `syncToolsToDb` involvement, no drift to reconcile when the remote server changes its tool set.
- The existing Tools tab is untouched. MCP is managed only in its own tab.

### 4. Management API — `mcp-servers.controller.ts` (mirror of channels)

- `GET  /api/instances/:slug/mcp-servers` — list (credentials redacted in the response).
- `PUT  /api/instances/:slug/mcp-servers/:serverSlug` — create/update.
- `DELETE /api/instances/:slug/mcp-servers/:serverSlug` — delete.
- `POST /api/instances/:slug/mcp-servers/test` — connect + `tools()` against a candidate config, return discovered tool names (for the UI and to seed the allow-list). No persistence.
- Controllers are pure HTTP bridges delegating to the store (project rule). Instance-scoped: every mutation verifies ownership via the resolved `InstanceUuid`.
- Destructive mutations (create-overwrite / delete) write a `management_audit_logs` row via the existing logger. The credential value is never audited (server slug + url only).

### 5. Web — new "MCP" tab

Instance detail gains an **MCP** tab:

- List of configured servers with enable/disable toggle, edit, delete.
- Add/edit form: name, url, `authMode` select (only `static` active in V1), auth type (bearer / custom header + header name), token (write-only, never returned), optional allow-list.
- **Test connection** button -> `POST .../test` -> renders discovered tool names; the operator can tick which ones go into the allow-list.
- Follows the frontend-design-system skill (shadcn/ui, existing Channels tab as the visual template).

### 6. Export / import

- `export.schema.ts` gains `mcpServers[]`; envelope version bumps to **`1.2`** (importer accepts `1.0`/`1.1`/`1.2`; every new field `.default()`ed).
- Credentials are **stripped** on export (`stripSensitiveKeys`, same as channels) -> `mcp_credentials` warning on import; the server imports **disabled** until credentials are re-entered.

### 7. Security

- **SSRF:** the url is admin-supplied (trusted, never LLM-supplied), but validate `https://` scheme and reject private / link-local / loopback hosts in production. Enforce a request timeout on all MCP calls.
- **Untrusted tool output:** MCP tools are remote and untrusted; their output enters the LLM context — an inherent prompt-injection surface for any MCP client. Documented as an accepted V1 risk; mitigated only by the operator choosing which servers to connect.
- **Resilience:** MCP connection / `tools()` failure is log-and-continue — a dead server never blocks the turn; the remaining tools stay available. Per-server errors are surfaced in the pipeline trace.
- **Secrets at rest:** encrypted in `config` (AES-256-GCM), redacted in API responses and audit logs.

## Data flow (per turn)

```
pipeline -> prepareSupervisor -> buildTools
   -> (existing) core/plugin/agent tools
   -> (new) for each enabled MCP server: createMCPClient -> tools() -> wrap + namespace
supervise/superviseStream
   -> ai-gateway.chat/chatStream (tools include mcp__*)
   -> tool loop invokes MCP tools over their open client
   -> finally: close all MCP clients (also on abort)
```

## Error handling

| Failure | Behavior |
|---------|----------|
| Connect/handshake fails | Log warn, skip that server, continue turn |
| `tools()` fails | Log warn, skip that server, continue turn |
| Tool invocation errors | Propagated as a normal tool error into the loop (model can react) |
| Client close fails | Log, swallow (best-effort cleanup) |
| Invalid stored config | Server treated as disabled, warn |

## Testing

- **Unit:** store CRUD + Zod config validation; `httpTransport` header construction (bearer vs custom header); allow-list filtering; namespacing (`mcp:server:tool` -> `mcp__server__tool`).
- **Unit (mocked client):** `buildTools` synthesizes and wraps MCP tools; a failing server is skipped without aborting; clients are closed in `finally` and on abort.
- **Integration:** management API CRUD + `test` endpoint against a mock MCP HTTP server; export/import round-trip strips credentials and imports disabled.
- **Security:** url validation rejects loopback/private hosts; API responses and audit rows never contain the token.

## Open questions / future work

- **V2 per-user / OAuth** — collect the user identity (channel identity via `ctx.state.channel`, or the authenticated playground user), a callback endpoint (OAuth 2.1 + PKCE), token storage keyed by `(instance, server, identity)`, refresh, and a way to deliver the consent link on async channels. Reserved via `authMode` + `authProvider`. Separate spec.
- **Per-tool granularity** — beyond the allow-list, real per-tool enablement would require catalog sync + drift handling. Deferred until requested.
- **Connection pooling / tool-list cache** — only if per-turn latency becomes a measured problem.
