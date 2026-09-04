# MCP Client Support (remote, per-instance) — Design

- **Date:** 2026-07-20
- **Status:** Approved (design)
- **Scope:** V1 — consume tools from external MCP servers over remote HTTP transport, with per-instance auth in two modes: `static` (bearer/header) and `oauth` — **MCP-native OAuth 2.1** (server-metadata discovery + dynamic client registration + PKCE, driven by `@ai-sdk/mcp`'s `auth()`), with tokens stored per-conversation in the existing `principal_secrets` vault.

## Context

Polyant agents can only use tools that live in the engine (core `*.tool.ts`, plugins, and virtual `agent:`/`spawnTask` tools). `ROADMAP.md` lists "First-party MCP server support for tools". This spec covers the **client** direction: an instance connects to external Model Context Protocol (MCP) servers and exposes their tools to the supervisor as if they were native tools.

There is no MCP code in the repo today — this is greenfield. The design deliberately reuses three existing seams:

1. **`instance_channels`** (encrypted per-instance config blob) as the template for MCP server config storage.
2. The **virtual-tool synthesis** in `buildTools` (`supervisor/index.ts`, the `agent:{slug}` block) as the template for turning a remote tool list into live AI SDK `Tool`s at runtime — bypassing the static registry and the `instance_tools` catalog.
3. The **per-conversation secret vault** (`principal_secrets`) + the callback-controller pattern (`oauth-callback.controller.ts`) as the storage + redirect backend for `oauth`-mode servers. `@ai-sdk/mcp`'s `auth()` drives the OAuth 2.1 flow (discovery / DCR / PKCE / exchange / refresh); we supply only a vault-backed `OAuthClientProvider` + one new callback route (see §8).

## Decisions

| Axis | Decision |
|------|----------|
| Direction | **Client** — agents consume external MCP tools |
| Transport | **Remote HTTP only** (Streamable HTTP + SSE). No stdio, no subprocess, no extra container binaries |
| Auth (V1) | Two modes, driven by the `authMode` column: **`static`** — per-instance bearer / custom header (encrypted config); **`oauth`** — **MCP-native OAuth 2.1** (server-metadata discovery + dynamic client registration + PKCE), driven by `@ai-sdk/mcp`'s `auth()` / `authProvider`. Tokens + PKCE verifier stored **per-conversation** in `principal_secrets`; the DCR client registration stored **per-(instance, server)**. A synthetic connect tool surfaces the authorize link on first use |
| Optional (oauth) | Pre-registered client credentials in the server's encrypted config, for servers that do **not** support DCR (otherwise DCR auto-registers a client) |
| Enablement | **Server-level** on/off. No per-tool catalog sync, no drift handling. Optional per-server allow-list |
| Library | **`@ai-sdk/mcp@^1.0` `createMCPClient`** (first-party Vercel; the 1.x line matches `ai@6`'s `@ai-sdk/provider@3.x` — 2.x pulls provider@4 and breaks typecheck) — not `@modelcontextprotocol/sdk` directly |
| Connection lifecycle | **Per-turn** — open in `buildTools`, close in a `finally` at the end of `supervise`/`superviseStream` and on abort |

### Non-goals (V2+)

- **Catalog-provider OAuth reuse** — an earlier idea to broker a token from a pre-registered IdP via the existing `oauth-providers.ts` catalog. Superseded: MCP-native `oauth` covers the general "connect to a cloud MCP server" case (and still uses the per-conversation vault for storage), while `static` covers bring-your-own-token. Not built.
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
    headers: { Authorization: "Bearer <token>" }, // authMode="static"
    // authProvider: makeMcpOAuthProvider(...),    // authMode="oauth" — MCP-native OAuth 2.1 (§8)
  },
});
const toolSet = await client.tools(); // Record<name, Tool> already in AI SDK shape
// ... use in generateText/streamText ...
await client.close();
```

`client.tools()` returns tools whose `inputSchema` is JSON Schema and whose `execute` uses the connected client — the exact shape `buildTool` already produces, so no Zod round-trip and no bespoke transport code. The `authProvider` field is where our vault-backed `OAuthClientProvider` plugs in (§8): the SDK drives discovery / DCR / PKCE / token exchange, we supply only storage + redirect capture.

**Implementation note (verified 2026-07-23):** pin **`@ai-sdk/mcp@^1.0`** (latest 1.x = `1.0.64`), NOT the dist-tag `latest` (2.x). Same discipline as the `@ai-sdk/openai-compatible` pin — a mismatched `@ai-sdk/provider` major breaks typecheck. Concretely: `ai@6.0.194` resolves `@ai-sdk/provider@3.0.10`; `@ai-sdk/mcp@1.x` depends on `@ai-sdk/provider@3.x` (aligned ✓), while `@ai-sdk/mcp@2.x` depends on `@ai-sdk/provider@4.x` (`LanguageModelV4` — `"v4" not assignable to "v2/v3"`, the exact break CLAUDE.md documents for openai-compatible). `ai@6` bundles NO MCP client of its own, so the separate package is required. `createMCPClient` (aliased `experimental_createMCPClient`) and the OAuth surface (`OAuthClientProvider`, `auth`, `UnauthorizedError`, `OAuthClientInformation`) are all exported by the 1.x line. Re-align the pin on every `ai` bump (verify `ai`'s `@ai-sdk/provider` major, then pick the `@ai-sdk/mcp` line that matches it).

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
  authMode    varchar(20) not null default 'static',  -- V1: 'static' | 'oauth' (MCP-native OAuth 2.1)
  enabled     boolean not null default true,
  config      text not null,           -- encrypt(JSON) — static: { auth, allowList? }; oauth: { scopes?, staticClient?, dcrClient?, allowList? }
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
  // authMode = "oauth"   — MCP-native OAuth 2.1 (usually NO secret: DCR auto-registers)
  {
    scopes?: string[],                                        // optional scopes to request
    staticClient?: { clientId: string; clientSecret?: string }, // ONLY for servers without DCR support
    dcrClient?: OAuthClientInformation,                        // written back after dynamic registration (per instance+server)
    allowList?: string[]
  }
  ```
- In `static` mode credentials live **inside** the encrypted `config` (matches the channels pattern). In `oauth` mode the config carries **no user token** — access/refresh tokens + the PKCE verifier live in the per-conversation `principal_secrets` vault (see §8). The **client registration** (from DCR, or a pre-provided `staticClient`) is NOT user-specific, so it is stored on the server row (`dcrClient` inside the encrypted `config`, per `(instance, server)`) and reused across all conversations — the first authorization triggers DCR, subsequent ones reuse it.
- `authMode` is a real column (not buried in `config`), so both modes are queryable and a future third mode is an additive value, not a destructive migration.
- Store surface mirrors channels: `setMcpServer`, `getMcpServer`, `listMcpServers(instanceUuid)`, `listEnabledMcpServers(instanceUuid)`, `deleteMcpServer`. Store functions take `InstanceUuid` (uuid-FK table, per the branded-identifier convention). Per-server config validated with a Zod schema before encrypt.

### 2. Runtime — synthesis in `buildTools` + per-turn lifecycle

In `supervisor/index.ts`, a new block right after the `agent:{slug}` synthesis (~`index.ts:317`):

```
for each server in listEnabledMcpServers(instanceUuid):
    transport = server.authMode === "static"
        ? { type, url, headers: staticHeaders(server) }              // bearer / custom header from config
        : { type, url, authProvider: makeMcpOAuthProvider(server, ctx) }  // MCP-native OAuth
    try:
        client = await createMCPClient({ transport })                // on 401 the SDK runs auth(): discovery + DCR + PKCE
        toolSet = await client.tools()
        for [toolName, tool] of toolSet:
            if allowList and toolName not in allowList: continue
            key = `mcp:${server.slug}:${toolName}`                    // internal name
            tools[toModelToolName(key)] = wrapToolWithAudit(key, tool, ...)  // -> mcp__server__tool
        openClients.push(client)
    catch (e):
        if e instanceof UnauthorizedError:                            // oauth: no valid token; auth() stashed the authorize URL
            url = provider.pendingAuthorizeUrl                        // captured in redirectToAuthorization()
            key = `mcp:${server.slug}:connect`
            tools[toModelToolName(key)] = synthConnectTool(server, url)  // execute -> { status:"action_required", url }
        else:
            console.warn(...)                                         // dead server -> skip, keep the other tools
```

- **static** mode → the transport carries a `headers` map (`{ Authorization: "Bearer <token>" }` or `{ <headerName>: <token> }`) built from the decrypted config, no `authProvider`.
- **oauth** mode → the transport carries an `authProvider` = `makeMcpOAuthProvider(server, ctx)` (§8). `createMCPClient` connects; if the server returns 401 the SDK's `auth()` runs discovery + DCR (or reuses `dcrClient`) + PKCE, calls the provider's `redirectToAuthorization(url)` (which stashes the URL), and — having no code yet — the transport throws `UnauthorizedError`. We catch it and synthesize a single **connect tool** carrying that stashed authorize URL.
- The **synthetic connect tool** mirrors the `agent:{slug}` synthesis + the intent-driven `action_required` pattern: when the model calls `mcp__<slug>__connect`, its `execute` returns `{ status: "action_required", url }` (the authorize link tied to this conversation via the `state` nonce). The user authorizes → the callback exchanges the code and `saveTokens` into the vault → the **next turn** `createMCPClient` finds the token, connects, and the real `mcp__<slug>__*` tools replace the connect tool. This bridges the buildTools-time (pre-LLM) MCP connection with the post-LLM intent-driven flow — no pre-LLM browser interaction needed.
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
- `POST /api/instances/:slug/mcp-servers/test` — for `static` mode: connect + `tools()` against a candidate config, return discovered tool names (for the UI and to seed the allow-list). For `oauth` mode: attempt the connect; a 401 that triggers discovery means the server is a valid MCP OAuth endpoint → return `{ requiresOAuth: true, authorizeUrl? }` (no token is minted, nothing persisted). A hard failure (unreachable / no MCP handshake) returns an error.
- `GET /mcp/oauth/callback` (`mcp-oauth-callback.controller.ts`, `@Public()`) — the OAuth redirect URI. Mirrors the existing `oauth-callback.controller.ts`: consumes the single-use `state` (→ instance + conversation + server), reconstructs the `OAuthClientProvider`, calls `@ai-sdk/mcp` `auth(provider, { serverUrl, authorizationCode, callbackState })` which exchanges the code and `saveTokens` into the vault, then renders a minimal success/error HTML page (all output escaped). Distinct route from `/oauth/:provider/callback` so the two flows never collide.
- Controllers are pure HTTP bridges delegating to the store (project rule). Instance-scoped: every mutation verifies ownership via the resolved `InstanceUuid`.
- Destructive mutations (create-overwrite / delete) write a `management_audit_logs` row via the existing logger. The credential value is never audited (server slug + url only).

### 5. Web — new "MCP" tab

Instance detail gains an **MCP** tab:

- List of configured servers with enable/disable toggle, edit, delete.
- Add/edit form: name, url, `authMode` select (**`static`** and **`oauth`** both active in V1):
  - `static` → auth type (bearer / custom header + header name), token (write-only, never returned).
  - `oauth` → **no credential fields needed** (DCR auto-registers): optional scopes; an optional "advanced" disclosure to paste a pre-registered `staticClient` client id/secret for servers without DCR. Tokens are acquired per-conversation at chat time via the connect link.
- optional allow-list (both modes).
- **Test connection** button -> `POST .../test` -> `static`: renders discovered tool names to tick into the allow-list; `oauth`: renders "reachable — requires authorization at chat time" (or the specific handshake error).
- Follows the frontend-design-system skill (shadcn/ui, existing Channels tab as the visual template).

### 6. Export / import

- `export.schema.ts` gains `mcpServers[]`; envelope version bumps to **`1.2`** (importer accepts `1.0`/`1.1`/`1.2`; every new field `.default()`ed).
- `static`-mode credentials are **stripped** on export (`stripSensitiveKeys`, same as channels) -> `mcp_credentials` warning on import; a static server imports **disabled** until credentials are re-entered.
- `oauth`-mode servers carry **no user token** in `config` (tokens live in the per-conversation vault, never exported). The `dcrClient` registration and any `staticClient.clientSecret` **are stripped** on export (`stripSensitiveKeys`): a dynamically-registered client is instance-specific, so on the target the server imports **enabled** but re-runs DCR (or needs its `staticClient` re-entered) on first authorization. A `mcp_oauth_reauth` info warning flags that re-authorization is required.

### 7. Security

- **SSRF:** the url is admin-supplied (trusted, never LLM-supplied), but validate `https://` scheme and reject private / link-local / loopback hosts in production. Enforce a request timeout on all MCP calls.
- **Untrusted tool output:** MCP tools are remote and untrusted; their output enters the LLM context — an inherent prompt-injection surface for any MCP client. Documented as an accepted V1 risk; mitigated only by the operator choosing which servers to connect.
- **Resilience:** MCP connection / `tools()` failure is log-and-continue — a dead server never blocks the turn; the remaining tools stay available. Per-server errors are surfaced in the pipeline trace.
- **Secrets at rest:** encrypted in `config` (AES-256-GCM), redacted in API responses and audit logs. In `oauth` mode the per-conversation access/refresh tokens live in the `principal_secrets` vault (already AES-256-GCM); the client registration (`dcrClient`/`staticClient`, including any client secret) lives in the encrypted server `config` — never in plaintext, never in API responses or audit rows.

## 8. OAuth mode — MCP-native OAuth 2.1 (vault-backed)

`@ai-sdk/mcp` ships the OAuth **engine**: on a 401 the HTTP/SSE transport calls `auth(authProvider, { serverUrl, resourceMetadataUrl })` (`index.mjs:1359`), which performs protected-resource → authorization-server **metadata discovery**, **dynamic client registration** (RFC 7591, when the AS advertises a `registration_endpoint` and no `clientInformation()` exists), **PKCE**, and the code/refresh **token exchange**. When it needs the user, it calls `provider.redirectToAuthorization(url)` and returns `"REDIRECT"`, and the transport throws `UnauthorizedError`. We implement only the **storage + redirect adapter**.

### 8.1 `makeMcpOAuthProvider(server, ctx)` — a vault-backed `OAuthClientProvider`

The `OAuthClientProvider` interface (`@ai-sdk/mcp` `index.d.ts:155`) maps cleanly onto existing storage, split by natural key:

| Method | Backing store | Key |
|--------|---------------|-----|
| `get redirectUrl()` | constant | `<baseUrl>/mcp/oauth/callback` |
| `get clientMetadata()` | constant | `{ redirect_uris:[redirectUrl], client_name, grant_types:["authorization_code","refresh_token"], response_types:["code"], token_endpoint_auth_method, scope }` |
| `clientInformation()` / `saveClientInformation()` | server row `config.dcrClient` (or `config.staticClient`) | **per (instance, server)** — DCR client is not user-specific; shared across conversations |
| `tokens()` / `saveTokens()` | `principal_secrets` vault | **per conversation** — `mcp_<slug>_tokens` under `scope_key=conversationId` |
| `saveCodeVerifier()` / `codeVerifier()` | `principal_secrets` vault | per conversation — `mcp_<slug>_verifier` |
| `state()` / `saveState()` / `storedState()` | `oauth_states` (reused) | row `{ state, instanceId, conversationId, provider: "mcp:<slug>" }` — how the stateless callback recovers context |
| `saveAuthorizationServerInformation()` / `authorizationServerInformation()` | server row `config` (optional cache) | per (instance, server) — skip discovery on subsequent turns |
| `redirectToAuthorization(url)` | in-memory field `pendingAuthorizeUrl` | captured, not followed — surfaced by the connect tool |

- **Token storage stays in the existing `principal_secrets` vault** (AES-256-GCM, per-conversation), honoring the original "per-conversation vault" requirement. New key prefix `mcp_<serverSlug>_*` alongside the existing `<provider>_oauth_*` keys — no schema change.
- **`saveClientInformation` writes back to the server's `config`** (a `setMcpServer` update merging `dcrClient`), so DCR runs once per (instance, server) and every later conversation reuses the registration.
- `token_endpoint_auth_method` = `"client_secret_post"` when a client secret exists (DCR-issued or `staticClient`), else `"none"` (public client + PKCE).

### 8.2 Callback

`GET /mcp/oauth/callback?code&state` (`mcp-oauth-callback.controller.ts`, `@Public()`): look up `state` in `oauth_states` → `{ instanceId, conversationId, serverSlug }`; load the server; build the same `makeMcpOAuthProvider`; call `auth(provider, { serverUrl: server.url, authorizationCode: code, callbackState: state })` — the SDK exchanges the code (using the vault-stored verifier) and calls `saveTokens`. Render an escaped success page. This is a near-clone of `oauth-callback.controller.ts`, on a distinct route so the two flows never collide.

### 8.3 Constraints (documented, not blockers)

- **Rooms regenerate `conversationId` per run** (`room:{instanceId}:{ts}`), so per-conversation tokens never persist across room cycles → `oauth`-mode servers are skipped on the supervise-direct Room/webhook paths (no stable conversation to bind a token to). `static`-auth servers work everywhere. A **per-principal token scope** (the vault's existing `scope`/`scope_key` abstraction already anticipates it) is the follow-up that makes `oauth` servers usable in Room.
- **DCR is per (instance, server), tokens are per conversation** — so two users of the same instance share the client registration but each authorizes their own token. Correct for the multi-user instance model.
- **State nonce TTL** — reuse `oauth_states`' 10-minute single-use window; an authorize link that sits unused past it fails cleanly and the model re-issues one next turn.

## Data flow (per turn)

```
pipeline -> prepareSupervisor -> buildTools
   -> (existing) core/plugin/agent tools
   -> (new) for each enabled MCP server:
        static -> createMCPClient({ headers })      -> tools() -> wrap + namespace
        oauth  -> createMCPClient({ authProvider })  -> tools() -> wrap + namespace
                  (401 -> SDK auth(): discovery + DCR + PKCE; if no code yet ->
                   UnauthorizedError -> synth mcp__<slug>__connect tool w/ authorize URL)
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
| `oauth` server, no valid token (401) | SDK `auth()` runs discovery/DCR + stashes the authorize URL; `UnauthorizedError` caught → synthesize `mcp__<slug>__connect` tool carrying that URL |
| `oauth` server, discovery / DCR fails | Not an `UnauthorizedError` (e.g. no metadata, registration rejected) → log warn, skip server, continue turn |
| `oauth` server, ephemeral `conversationId` (room) | Skip the server (no stable conversation to bind a token) |
| Callback: unknown / expired `state` | 400 escaped error page; nothing persisted (mirrors existing callback) |

## Testing

- **Unit:** store CRUD + Zod config validation (both `static` and `oauth` discriminated shapes); static `headers` construction (bearer vs custom header); allow-list filtering; namespacing (`mcp:server:tool` -> `mcp__server__tool`).
- **Unit (oauth provider):** `makeMcpOAuthProvider` — `tokens()`/`saveTokens` round-trip through a mocked `principal_secrets` (per-conversation key); `clientInformation()`/`saveClientInformation` read/write the server `config.dcrClient` (per instance+server); `saveCodeVerifier`/`codeVerifier` per conversation; `state()`/`storedState` via `oauth_states`; `redirectToAuthorization` captures `pendingAuthorizeUrl`; `clientMetadata`/`redirectUrl` shape; `token_endpoint_auth_method` = `none` (no secret) vs `client_secret_post`.
- **Unit (buildTools, mocked client):** static → headers transport, no `authProvider`; oauth with a stored token → connects + wraps tools; oauth raising `UnauthorizedError` → synth `mcp__<slug>__connect` tool carrying the stashed URL; a non-`UnauthorizedError` failure → server skipped without aborting; ephemeral `conversationId` (room) → oauth server skipped; clients closed in `finally` and on abort.
- **Integration:** management API CRUD + `test` endpoint against a mock MCP HTTP server (static tool-list + oauth `requiresOAuth` branch); the `GET /mcp/oauth/callback` flow against a mock MCP OAuth server — `state` resolves context, `auth()` exchanges the code + `saveTokens`, single-use state; export/import round-trip — `static` strips credentials + imports disabled, `oauth` round-trips enabled with `dcrClient`/`staticClient` secret stripped.
- **Security:** url validation rejects loopback/private hosts; API responses and audit rows never contain tokens or client secrets; callback escapes all output.

## Open questions / future work

- **Per-principal token scope** — today the vault keys tokens by `conversationId`; a per-principal tier (token shared across a person's conversations, and usable in Room) is a drop-in via the vault's existing `scope`/`scope_key` abstraction. Needed to make `oauth`-mode MCP servers work in Room and to avoid re-authorizing per conversation.
- **Elicitation / sampling** — `@ai-sdk/mcp` exposes MCP elicitation + client capabilities; not wired in V1 (tools only).
- **Per-tool granularity** — beyond the allow-list, real per-tool enablement would require catalog sync + drift handling. Deferred until requested.
- **Connection pooling / tool-list cache** — only if per-turn latency becomes a measured problem.
