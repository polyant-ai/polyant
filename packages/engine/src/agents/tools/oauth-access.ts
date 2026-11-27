// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared OAuth-access helper for tools that consume a per-conversation OAuth
// token. Instead of a dedicated "connect" tool, each data tool delegates here:
// if the token is present it proceeds, otherwise it returns a ready-to-click
// authorize link tied to THIS conversation. Intent-driven ("show my repos" →
// link if not connected → retry) and least-privilege (a tool declares only the
// credentials of the provider it actually uses, via oauthRequiredSecrets).

import { randomBytes } from "crypto";
import type { RequiredSecretSpec } from "@polyant-ai/plugin-sdk";
import type { ToolContext, OAuthAccessApi, OAuthTokenResult } from "./registry.js";
import {
  getOAuthProvider,
  resolveClientId,
  buildAuthorizeUrl,
  generatePkcePair,
  oauthSecretKeys,
  type OAuthProviderScope,
} from "../../server/oauth/oauth-providers.js";
import { getValidAccessToken } from "../../server/oauth/oauth-token-service.js";
import { createOAuthState } from "../../server/oauth/oauth-states.store.js";
import { getOAuthAuthorizationScopes } from "../../server/oauth/oauth-authorization-scopes.port.js";

/** The requiredSecrets a tool must declare to use a provider: the client_id
 *  (public → readable) and the client_secret (masked; only the callback reads it,
 *  but declaring it here is what surfaces its Settings slot). Derived from the
 *  provider name, so a new provider needs no bespoke list. */
export function oauthRequiredSecrets(providerName: string): RequiredSecretSpec[] {
  const { clientIdKey, clientSecretKey } = oauthSecretKeys(providerName);
  return [
    { key: clientIdKey, type: "text", sensitive: false, label: `${providerName} OAuth client id` },
    { key: clientSecretKey, type: "text", sensitive: true, label: `${providerName} OAuth client secret` },
  ];
}

/** An `action_required` tool result carrying the authorize link for this
 *  conversation, or an `error` result when the provider/credentials are missing.
 *  Generates a single-use `state` nonce (+ PKCE where supported) and persists it
 *  server-side (oauth_states) so the callback can map the redirect back safely.
 *  `scope` names the registry the provider is read from (null: the shared one);
 *  a scoped authorization records its scope for the callback. */
export async function oauthConnectResult(
  ctx: ToolContext,
  providerName: string,
  scope: OAuthProviderScope = null,
): Promise<Record<string, unknown>> {
  const provider = getOAuthProvider(providerName, scope);
  const clientId = resolveClientId(providerName, ctx.secrets);
  if (!provider || !clientId || !ctx.conversationId) {
    return { error: `OAuth non configurato per "${providerName}" o contesto conversazione incompleto.` };
  }

  const state = randomBytes(32).toString("base64url");
  const pkce = provider.pkce ? generatePkcePair() : null;
  await createOAuthState({
    state,
    conversationId: ctx.conversationId,
    instanceId: ctx.instanceId,
    provider: providerName,
    codeVerifier: pkce?.verifier ?? null,
  });
  if (scope !== null) await getOAuthAuthorizationScopes().remember(state, scope);

  return {
    status: "action_required",
    message: `Per procedere collega il tuo account ${providerName}: apri il link, autorizza, poi richiedimi la stessa cosa.`,
    url: await buildAuthorizeUrl(provider, state, clientId, pkce?.challenge),
  };
}

/** A valid access token for the provider on this conversation (refreshing an
 *  expired one server-side); if absent/unrefreshable, return the connect result
 *  the tool hands straight back to the caller. */
export async function requireOAuthToken(
  ctx: ToolContext,
  providerName: string,
  scope: OAuthProviderScope = null,
): Promise<OAuthTokenResult> {
  if (ctx.conversationId) {
    const token = await getValidAccessToken(ctx.instanceId, ctx.conversationId, providerName, scope);
    if (token) return { ok: true, token };
  }
  return { ok: false, result: await oauthConnectResult(ctx, providerName, scope) };
}

/** Build the `ctx.oauth` accessor bound to this tool's context. This is the
 *  engine's implementation of the SDK's OAuthAccessApi — the single surface OAuth
 *  tools (core or plugin) use to reach engine-brokered tokens. `scope` is the
 *  provider registry this tool reads; null, the default, is the shared one. */
export function makeOAuthAccess(ctx: ToolContext, scope: OAuthProviderScope = null): OAuthAccessApi {
  return {
    requireToken: (provider) => requireOAuthToken(ctx, provider, scope),
    connectResult: (provider) => oauthConnectResult(ctx, provider, scope),
  };
}
