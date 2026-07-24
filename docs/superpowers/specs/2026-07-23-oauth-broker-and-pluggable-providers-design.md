# Per-conversation OAuth broker + plugin-contributed providers — Design Record

**Date:** 2026-07-23
**Status:** Implemented (`feat/oauth-per-conversation`)
**Scope:** engine `server/oauth/*`, per-conversation secret vault, tool `ctx.oauth`, plugin manifest, `@polyant-ai/plugin-sdk` (`OAuthProviderSpec`).

## Problem

A tool's third-party credentials were per-instance — one token shared by every
conversation. Some use cases need each conversation to authorize its OWN account
(a user connects their GitHub / Gmail and the agent acts on that user's data).
And once a broker exists, its provider catalog must not be hardcoded in the
engine: a plugin should be able to ship an OAuth tool AND the provider it needs
without any engine change, consistent with the serialized-plugin mechanism.

## Part 1 — The broker

A generic, data-driven OAuth broker (`server/oauth/`):

- **Provider registry** (`oauth-providers.ts`): provider metadata
  (`authorizeUrl`, `tokenUrl`, `scope`, `extraAuthorizeParams`, `pkce`), keyed by
  name. NO credentials.
- **Single callback**: `@Public() GET /oauth/:provider/callback` swaps the code
  for a token. Each provider registers its own `<BASE_URL>/oauth/<name>/callback`.
- **Per-instance client credentials**: `instance_secrets`
  (`<provider>_oauth_client_id` readable / `_client_secret` callback-only, no env
  fallback). The `client_secret` is resolved ONLY server-side in the callback —
  it never enters tool/LLM context.
- **Encrypted per-conversation vault** (`principal_secrets`, AES-256-GCM): access
  and refresh tokens live here, NOT in the cleartext, promptable
  `conversation_state`. Keyed `scope`/`scope_key` (today `conversation`), leaving
  room for a future per-principal tier. Purged with the conversation
  (`deleteConversation`) and the instance (`deleteInstance`).
- **Refresh-aware access** (`oauth-token-service.getValidAccessToken`): refreshes
  an expired token server-side.
- **CSRF-safe** `state` nonce + PKCE (S256) in `oauth_states` (single-use +
  expiring).
- **`ctx.oauth`** (`OAuthAccessApi`: `requireToken` / `connectResult`): a tool
  asks only for a valid token or a ready-to-return connect link; it never sees
  the `client_secret` nor handles the redirect. Mirrored structurally in the SDK
  (`>=1.3.0`) so plugin tools can consume it.

OAuth data tools themselves live in plugins (e.g. `polyant-oauthdemo-plugin`),
not in the engine.

## Part 2 — Pluggable provider registry

The registry starts EMPTY: the engine ships only the mechanism, and providers
come from plugins.

- **Declaration**: a plugin lists its providers under `oauthProviders` in
  `plugin.json` — pure data (`{ name, authorizeUrl, tokenUrl, scope,
  extraAuthorizeParams?, pkce? }`), validated by the engine's manifest Zod schema.
  **Zero SDK code is required** for this; the SDK exports an `OAuthProviderSpec`
  type only as optional authoring ergonomics.
- **Registration**: `loadAllTools()` registers each compatible plugin's
  `oauthProviders` inside the existing engine-range-gated roots loop, so an
  incompatible plugin (skipped by the `engine` range) contributes no providers.
  `registerOAuthProvider` is the registry's only writer.
- **Collision policy**: two plugins MAY declare the same provider name — if the
  definitions are identical they coexist (dedup, no-op); a same-name DIVERGENT
  definition fails the boot loud, exactly like a duplicate tool name.
  `extraAuthorizeParams` is compared order-independently so key ordering is not a
  false divergence.
- **No namespacing**: the provider name is a flat, global key — it flows verbatim
  into the per-instance secret keys (`<name>_oauth_client_id`), the token vault,
  and the callback route (`/oauth/<name>/callback`), and semantically you want ONE
  `google` shared per instance. For divergent scopes use distinct names (e.g.
  `google-gmail` vs `google-calendar`).

Everything downstream is already derived from the provider name, so making the
registry pluggable changed only its source — no other broker wiring.

## Testing

- `oauth-providers.test.ts`: empty-by-default registry; register / dedup-identical
  (order-independent) / fail-loud-on-divergent; authorize-URL + PKCE + credential
  resolution.
- `plugin-manifest.test.ts`: `oauthProviders` parse / default-`[]` / reject
  malformed.
- `plugin-loading.integration.test.ts`: a compatible fixture plugin's provider is
  registered at boot; an engine-incompatible plugin's is not (the range gate
  applies to providers too).
- `store.test.ts` / `instances/store.test.ts`: token vault purged on conversation
  and instance delete.

## Follow-ups

- Publish the provider definitions for the demo OAuth tools in the
  `polyant-oauthdemo-plugin` manifest (`oauthProviders`).
- Verify GitHub OAuth App PKCE support (currently `pkce:false`; the state nonce
  already closes CSRF).
