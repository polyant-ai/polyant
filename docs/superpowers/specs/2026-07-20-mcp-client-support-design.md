# MCP Client Support (remote, per-instance) — Design

- **Date:** 2026-07-20
- **Status:** Approved (design)
- **Scope:** V1 — consume tools from external MCP servers over remote HTTP transport, with per-instance auth in two modes: `static` (bearer/header) and `oauth` (reuse of the existing per-conversation OAuth vault).

## Context

Polyant agents can only use tools that live in the engine (core `*.tool.ts`, plugins, and virtual `agent:`/`spawnTask` tools). `ROADMAP.md` lists "First-party MCP server support for tools". This spec covers the **client** direction: an instance connects to external Model Context Protocol (MCP) servers and exposes their tools to the supervisor as if they were native tools.

There is no MCP code in the repo today — this is greenfield. The design deliberately reuses three existing seams:

1. **`instance_channels`** (encrypted per-instance config blob) as the template for MCP server config storage.
2. The **virtual-tool synthesis** in `buildTools` (`supervisor/index.ts`, the `agent:{slug}` block) as the template for turning a remote tool list into live AI SDK `Tool`s at runtime — bypassing the static registry and the `instance_tools` catalog.
3. The **per-conversation OAuth vault** (`oauth-token-service.ts` + `oauth-access.ts` + `principal_secrets` + `/oauth/:provider/callback`) as the auth backend for `oauth`-mode servers — no new OAuth infrastructure (see §8).

## Decisions

| Axis | Decision |
|------|----------|
| Direction | **Client** — agents consume external MCP tools |
| Transport | **Remote HTTP only** (Streamable HTTP + SSE). No stdio, no subprocess, no extra container binaries |
| Auth (V1) | Two modes, driven by the `authMode` column: **`static`** — per-instance bearer / custom header, credentials encrypted per instance; **`oauth`** — reuse the existing **per-conversation OAuth vault** (`getValidAccessToken` → inject as bearer header; a synthetic connect tool surfaces the authorize link when no token exists). No new OAuth infrastructure |
| Auth (future / V2) | **MCP-native OAuth 2.1** (dynamic client registration + per-server metadata discovery) via the AI SDK `authProvider` hook — generic to any cloud MCP server. Vault + callback reused; DCR + discovery are the only new pieces |
| Enablement | **Server-level** on/off. No per-tool catalog sync, no drift handling. Optional per-server allow-list |
| Library | **`@ai-sdk/mcp@^1.0` `createMCPClient`** (first-party Vercel; the 1.x line matches `ai@6`'s `@ai-sdk/provider@3.x` — 2.x pulls provider@4 and breaks typecheck) — not `@modelcontextprotocol/sdk` directly |
| Connection lifecycle | **Per-turn** — open in `buildTools`, close in a `finally` at the end of `supervise`/`superviseStream` and on abort |

### Non-goals (V2+)

- **MCP-native OAuth 2.1 with dynamic client registration (DCR) + server-metadata discovery** (the `authProvider` hook is the reserved seam). V1 `oauth` mode reuses the existing catalog-provider vault, so it covers MCP servers that accept a bearer token from an OAuth provider **registered via a plugin manifest** (static authorize/token URLs, PKCE, form-encoded exchange). Arbitrary cloud MCP servers that mandate DCR are out of V1.
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
    headers: { Authorization: "Bearer <token>" }, // V1: static token OR oauth-vault bearer
    // authProvider: <OAuthClientProvider>,        // V2 hook — MCP-native OAuth 2.1, reserved
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
  authMode    varchar(20) not null default 'static',  -- V1: 'static' | 'oauth'; (future) 'oauth-native' (DCR/discovery)
  enabled     boolean not null default true,
  config      text not null,           -- encrypt(JSON) — static: { auth, allowList? }; oauth: { oauthProvider, allowList? }
  createdAt   timestamptz not null default now(),
  updatedAt   timestamptz not null default now(),
  unique (instanceId, slug)
)
```

- `config` is the encrypted JSON blob (same `encrypt`/`safeDecryptConfig` helpers as channels). Decrypted shape is **discriminated by `authMode`**:
  ```ts
  // authMode = "static"  — credentials inside the encrypted blob
  {
    auth: { type: "bearer"; token: string }
        | { type: "header"; headerName: string; token: string },
    allowList?: string[]   // optional tool-name filter; empty/absent = all tools
  }
  // authMode = "oauth"    — NO secret in the blob
  {
    oauthProvider: string, // name of an OAuth provider registered via plugin manifest
    allowList?: string[]
  }
  ```
- In `static` mode credentials live **inside** the encrypted `config` (matches the channels pattern). In `oauth` mode the blob holds **no secret** — the token comes from the per-conversation vault at runtime, and the provider's OAuth **client id/secret live in `instance_secrets`** under the provider-derived keys (`<provider>_oauth_client_id` / `_oauth_client_secret`, via `oauthSecretKeys`), shared with any data tool using the same provider.
- `authMode` is a real column (not buried in `config`), so both modes are queryable and the future MCP-native OAuth path (V2) is an additive value, not a destructive migration.
- Store surface mirrors channels: `setMcpServer`, `getMcpServer`, `listMcpServers(instanceUuid)`, `listEnabledMcpServers(instanceUuid)`, `deleteMcpServer`. Store functions take `InstanceUuid` (uuid-FK table, per the branded-identifier convention). Per-server config validated with a Zod schema before encrypt.

### 2. Runtime — synthesis in `buildTools` + per-turn lifecycle

In `supervisor/index.ts`, a new block right after the `agent:{slug}` synthesis (~`index.ts:317`):

```
for each server in listEnabledMcpServers(instanceUuid):
    headers = await resolveMcpHeaders(server, ctx)   // static: from config; oauth: bearer from vault
    if headers === NEEDS_OAUTH:                       // oauth mode, no token this conversation yet
        key = `mcp:${server.slug}:connect`
        tools[toModelToolName(key)] = synthConnectTool(server, ctx)  // execute -> oauthConnectResult(ctx, server.oauthProvider)
        continue                                      // do NOT connect the client this turn
    client = await createMCPClient({ transport: httpTransport(server.url, headers) })
    toolSet = await client.tools()
    for [toolName, tool] of toolSet:
        if allowList and toolName not in allowList: continue
        key = `mcp:${server.slug}:${toolName}`                 // internal name
        tools[toModelToolName(key)] = wrapToolWithAudit(key, tool, ...)  // -> mcp__server__tool
    openClients.push(client)
```

- `resolveMcpHeaders(server, ctx)`: **static** mode → `{ Authorization: "Bearer <token>" }` or `{ <headerName>: <token> }` from the decrypted config. **oauth** mode → `getValidAccessToken(instanceSlug, ctx.conversationId, server.oauthProvider)`; a token → `{ Authorization: "Bearer <token>" }`, else the `NEEDS_OAUTH` sentinel.
- The **synthetic connect tool** mirrors the `agent:{slug}` synthesis + the intent-driven `action_required` pattern: when the model calls `mcp__<slug>__connect`, its `execute` returns `oauthConnectResult(ctx, server.oauthProvider)` (the ready-to-click authorize link tied to this conversation). After the user authorizes, the callback stores the token; the **next turn** `resolveMcpHeaders` finds it, the client connects, and the real `mcp__<slug>__*` tools replace the connect tool. This bridges the buildTools-time (pre-LLM) MCP connection with the post-LLM intent-driven OAuth flow — no pre-LLM browser interaction needed.
- `toModelToolName` already maps `:` -> `__`, so the model sees `mcp__github__create_issue` (and `mcp__github__connect` when unauthorized). Server slug in the namespace resolves cross-server name collisions.
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
- `POST /api/instances/:slug/mcp-servers/test` — for `static` mode: connect + `tools()` against a candidate config, return discovered tool names (for the UI and to seed the allow-list). For `oauth` mode: a live token-less connect is not possible pre-authorization, so `test` validates the url (scheme + reachability) and confirms the named provider is registered + has client credentials, returning `{ requiresOAuth: true, provider }` instead of a tool list. No persistence.
- Controllers are pure HTTP bridges delegating to the store (project rule). Instance-scoped: every mutation verifies ownership via the resolved `InstanceUuid`.
- Destructive mutations (create-overwrite / delete) write a `management_audit_logs` row via the existing logger. The credential value is never audited (server slug + url only).

### 5. Web — new "MCP" tab

Instance detail gains an **MCP** tab:

- List of configured servers with enable/disable toggle, edit, delete.
- Add/edit form: name, url, `authMode` select (**`static`** and **`oauth`** both active in V1):
  - `static` → auth type (bearer / custom header + header name), token (write-only, never returned).
  - `oauth` → an **OAuth provider picker** populated from the registered providers (needs a small read endpoint listing registered provider names, e.g. `GET /api/oauth/providers`); an inline hint that the provider's client id/secret must be configured in **Settings** (links there). No token field — tokens are acquired per-conversation at chat time.
- optional allow-list (both modes).
- **Test connection** button -> `POST .../test` -> `static`: renders discovered tool names to tick into the allow-list; `oauth`: renders "requires authorization (provider X)" + whether the provider is registered/credentialed.
- Follows the frontend-design-system skill (shadcn/ui, existing Channels tab as the visual template).

### 6. Export / import

- `export.schema.ts` gains `mcpServers[]`; envelope version bumps to **`1.2`** (importer accepts `1.0`/`1.1`/`1.2`; every new field `.default()`ed).
- `static`-mode credentials are **stripped** on export (`stripSensitiveKeys`, same as channels) -> `mcp_credentials` warning on import; a static server imports **disabled** until credentials are re-entered.
- `oauth`-mode servers carry **no secret in `config`** (only `oauthProvider`, non-secret), so they round-trip **enabled** — but the token vault and the provider's `instance_secrets` client id/secret are not exported, so authorization must be re-done on the target instance (a `mcp_oauth_provider` info warning names the provider to reconnect).

### 7. Security

- **SSRF:** the url is admin-supplied (trusted, never LLM-supplied), but validate `https://` scheme and reject private / link-local / loopback hosts in production. Enforce a request timeout on all MCP calls.
- **Untrusted tool output:** MCP tools are remote and untrusted; their output enters the LLM context — an inherent prompt-injection surface for any MCP client. Documented as an accepted V1 risk; mitigated only by the operator choosing which servers to connect.
- **Resilience:** MCP connection / `tools()` failure is log-and-continue — a dead server never blocks the turn; the remaining tools stay available. Per-server errors are surfaced in the pipeline trace.
- **Secrets at rest:** encrypted in `config` (AES-256-GCM), redacted in API responses and audit logs. In `oauth` mode no server credential is in `config` — the per-conversation token lives in the `principal_secrets` vault (already AES-256-GCM) and the provider client id/secret in `instance_secrets`.

## 8. OAuth mode (Tier 1 — reuse the per-conversation vault)

`oauth` mode adds **zero new OAuth infrastructure** — it composes existing engine pieces:

| Reused piece | Role for MCP |
|--------------|--------------|
| `getValidAccessToken(slug, conversationId, provider)` (`oauth-token-service.ts`) | Fetch a valid token (auto-refresh) at `buildTools` time; `null` → synthesize the connect tool |
| `oauthConnectResult(ctx, provider)` (`oauth-access.ts`) | Body of the synthetic `mcp__<slug>__connect` tool — returns the `action_required` authorize link |
| `principal_secrets` vault + `GET /oauth/:provider/callback` + `oauth_states` | Token storage + code exchange + single-use PKCE nonce — untouched |
| OAuth provider registry (`oauth-providers.ts`, plugin-manifest-populated) | `server.oauthProvider` names an entry; its authorize/token URLs + `<provider>_oauth_client_*` secrets drive the flow |

**Prerequisite:** the named `oauthProvider` must be **registered** (via a plugin manifest's `oauthProviders`) and its client id/secret set in the instance Settings. If the provider is unregistered or credentials are missing, `oauthConnectResult` already degrades to an `{ error }` result — surfaced to the model, not a crash.

**Constraints (documented, not blockers):**
- **Rooms regenerate `conversationId` per run** (`room:{instanceId}:{ts}`), so a per-conversation token never persists across room cycles → `oauth`-mode MCP servers are effectively unusable in Room. Room/webhook are supervise-direct anyway; `oauth` servers are simply skipped there (no token, connect tool has no stable conversation to bind). Static-auth servers work everywhere. Documented; per-principal token scope is the V2 fix (the vault's `scope`/`scope_key` abstraction already anticipates it).
- Token is shared per `(conversation, provider)` with any data tool using the same provider — connect once, both work. Scope differences are the provider's concern (its configured `scope`).

## Data flow (per turn)

```
pipeline -> prepareSupervisor -> buildTools
   -> (existing) core/plugin/agent tools
   -> (new) for each enabled MCP server: resolveMcpHeaders
        -> token/static header  -> createMCPClient -> tools() -> wrap + namespace
        -> oauth, no token      -> synthesize mcp__<slug>__connect tool (skip client)
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
| `oauth` server, no vault token | Synthesize `mcp__<slug>__connect` tool (model surfaces the authorize link); no client connect this turn |
| `oauth` server, provider unregistered / no credentials | Connect tool's `oauthConnectResult` returns `{ error }` to the model; log warn |
| `oauth` server, ephemeral `conversationId` (room) | Skip the server (token cannot bind to a stable conversation) |

## Testing

- **Unit:** store CRUD + Zod config validation (both `static` and `oauth` discriminated shapes); `httpTransport` header construction (bearer vs custom header); allow-list filtering; namespacing (`mcp:server:tool` -> `mcp__server__tool`).
- **Unit (oauth mode):** `resolveMcpHeaders` — static returns configured header; oauth with a vault token returns bearer; oauth with no token returns the `NEEDS_OAUTH` sentinel. Synthetic `mcp__<slug>__connect` tool's `execute` returns `oauthConnectResult` (mocked). An `oauth` server with a missing/ephemeral `conversationId` (room) is skipped, not crashed.
- **Unit (mocked client):** `buildTools` synthesizes and wraps MCP tools; a failing server is skipped without aborting; clients are closed in `finally` and on abort.
- **Integration:** management API CRUD + `test` endpoint against a mock MCP HTTP server (static tool-list + oauth `requiresOAuth` branches); export/import round-trip — a `static` server strips credentials + imports disabled, an `oauth` server round-trips enabled with its `oauthProvider` preserved.
- **Security:** url validation rejects loopback/private hosts; API responses and audit rows never contain the token.

## Open questions / future work

- **V2 MCP-native OAuth 2.1** — for cloud MCP servers that mandate dynamic client registration + server-metadata discovery (no pre-registered catalog provider). Implement an `OAuthClientProvider` (the `@ai-sdk/mcp` `authProvider` seam) backed by the existing `principal_secrets` vault + callback, handling DCR and per-server discovery. Separate spec. (V1 `oauth` mode already covers catalog-provider bearer tokens per-conversation.)
- **Per-principal token scope** — today the vault keys tokens by `conversationId`; a per-principal tier (token shared across a person's conversations, and usable in Room) is a drop-in via the vault's existing `scope`/`scope_key` abstraction. Needed to make `oauth`-mode MCP servers work in Room.
- **Per-tool granularity** — beyond the allow-list, real per-tool enablement would require catalog sync + drift handling. Deferred until requested.
- **Connection pooling / tool-list cache** — only if per-turn latency becomes a measured problem.
