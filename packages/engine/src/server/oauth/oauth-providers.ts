// SPDX-License-Identifier: AGPL-3.0-or-later

// Generic OAuth broker: a data-driven provider registry shared by the tools that
// consume a provider (via oauth-access.ts, which builds the authorize link when a
// token is missing) and the /oauth/:provider/callback controller (swaps the code
// for a token).
//
// The registry is POPULATED AT BOOT from plugin manifests (`oauthProviders` in
// plugin.json) — it starts EMPTY. The engine ships only the broker mechanism;
// providers come from plugins, so a plugin can ship a provider without any engine
// change. `registerOAuthProvider` is the only writer.
//
// Client credentials are PER-INSTANCE ONLY: read from instance_secrets under
// `<provider>_oauth_client_id` / `<provider>_oauth_client_secret` (no env
// fallback). The client_secret is resolved ONLY server-side in the callback — it
// never enters tool/LLM context. The redirect URI is computed here (once) so the
// authorize link and the token exchange always agree.

import { randomBytes, createHash } from "crypto";
import { config } from "../../config.js";
import { getSecret } from "../../instances/secrets.store.js";
import type { AgentSlug } from "../../instances/identifiers.js";

export interface OAuthProvider {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Provider-specific authorize query params (e.g. Google's offline access). */
  extraAuthorizeParams: Record<string, string>;
  /** Whether the provider supports PKCE (S256). The state nonce protects CSRF
   *  regardless; PKCE additionally hardens against code interception. */
  pkce: boolean;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE verifier + S256 challenge (RFC 7636). */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The conversation_state key under which a provider's access token is stored.
 *  Derived from the provider name (no per-provider constant) — symmetric with
 *  oauthSecretKeys, so a new provider needs zero extra wiring. Shared by the
 *  callback (writer) and the per-service data tools (readers). */
export function oauthTokenStateKey(providerName: string): string {
  return `${providerName}_oauth_token`;
}

/** Vault key for a provider's refresh token (persisted alongside the access
 *  token when the provider issues one). */
export function oauthRefreshStateKey(providerName: string): string {
  return `${providerName}_oauth_refresh`;
}

export interface OAuthCredentials {
  clientId?: string;
  clientSecret?: string;
}

/** Provider metadata registry — populated at boot from plugin manifests
 *  (`oauthProviders` in plugin.json), keyed by provider name. Starts EMPTY: the
 *  engine ships the mechanism, plugins ship the providers. NO credentials here
 *  (those are per-instance, resolved separately). */
const REGISTRY = new Map<string, OAuthProvider>();

/** Normalized equality of two provider specs. `extraAuthorizeParams` is compared
 *  independently of key order so two manifests that differ only in ordering are
 *  NOT a false divergence. */
function sameProvider(a: OAuthProvider, b: OAuthProvider): boolean {
  const norm = (p: OAuthProvider) =>
    JSON.stringify({
      name: p.name,
      authorizeUrl: p.authorizeUrl,
      tokenUrl: p.tokenUrl,
      scope: p.scope,
      pkce: p.pkce,
      extraAuthorizeParams: Object.fromEntries(
        Object.entries(p.extraAuthorizeParams).sort(([x], [y]) => x.localeCompare(y)),
      ),
    });
  return norm(a) === norm(b);
}

/** Register a provider (the only writer of REGISTRY). Dedup on an identical
 *  definition (no-op); a same-name DIVERGENT definition throws so the loader lets
 *  it abort the boot, like a duplicate tool name. */
export function registerOAuthProvider(p: OAuthProvider): void {
  const existing = REGISTRY.get(p.name);
  if (existing) {
    if (!sameProvider(existing, p)) {
      throw new Error(
        `OAuth provider conflict "${p.name}": two plugins declare it with divergent ` +
          `definitions. Rename one (e.g. "${p.name}-<purpose>") or align authorizeUrl/tokenUrl/scope/pkce.`,
      );
    }
    return;
  }
  REGISTRY.set(p.name, p);
}

export function getOAuthProvider(name: string): OAuthProvider | undefined {
  return REGISTRY.get(name);
}

export function knownProviderNames(): string[] {
  return Array.from(REGISTRY.keys());
}

/** Test-only: clear the registry between tests. */
export function _resetOAuthRegistryForTests(): void {
  REGISTRY.clear();
}

/** The instance_secrets key names holding a provider's client credentials.
 *  Single source of the naming convention (used by the tool's requiredSecrets,
 *  the tool's read, and the callback's resolution). */
export function oauthSecretKeys(providerName: string): { clientIdKey: string; clientSecretKey: string } {
  return {
    clientIdKey: `${providerName}_oauth_client_id`,
    clientSecretKey: `${providerName}_oauth_client_secret`,
  };
}

/** Resolve a provider's client_id from the tool's scoped secrets. Only the
 *  client_id is needed to build the authorize link. */
export function resolveClientId(
  providerName: string,
  secrets: Record<string, string> | undefined,
): string | undefined {
  const { clientIdKey } = oauthSecretKeys(providerName);
  return secrets?.[clientIdKey];
}

/** Resolve BOTH client credentials for the callback (server-side only), per
 *  instance from instance_secrets. */
export async function resolveOAuthCredentials(
  providerName: string,
  slug: AgentSlug,
): Promise<OAuthCredentials> {
  const { clientIdKey, clientSecretKey } = oauthSecretKeys(providerName);
  const [clientId, clientSecret] = await Promise.all([
    getSecret(slug, clientIdKey),
    getSecret(slug, clientSecretKey),
  ]);
  return { clientId, clientSecret };
}

/** Engine-public base URL. The callback is hit by the user's browser straight at
 *  the engine (not proxied through the web app), so this is the engine origin.
 *  Each provider registers its OWN callback: <base>/oauth/<name>/callback. */
function redirectUri(providerName: string): string {
  const base = config.server.baseUrl ?? `http://localhost:${config.server.port}`;
  return `${base.replace(/\/+$/, "")}/oauth/${providerName}/callback`;
}

/** Authorize URL the user clicks. `state` is an unguessable nonce (mapped
 *  server-side to the conversation via oauth_states). `codeChallenge` adds PKCE
 *  when the provider supports it. */
export function buildAuthorizeUrl(
  p: OAuthProvider,
  state: string,
  clientId: string,
  codeChallenge?: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(p.name),
    scope: p.scope,
    state,
    ...p.extraAuthorizeParams,
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${p.authorizeUrl}?${params.toString()}`;
}

export interface OAuthTokenResponse {
  accessToken: string;
  /** Present on first consent (Google, with access_type=offline); absent for
   *  providers whose tokens don't expire (GitHub) or on some refreshes. */
  refreshToken?: string;
  /** Access-token lifetime in seconds; absent when the token doesn't expire. */
  expiresIn?: number;
}

/** POST the provider token endpoint (form-encoded + Accept: JSON — works for
 *  GitHub and Google) and normalize the response. Throws on any failure. */
async function postToken(p: OAuthProvider, body: Record<string, string>): Promise<OAuthTokenResponse> {
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`${p.name} token endpoint returned ${res.status}`);
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!data.access_token) {
    throw new Error(data.error_description ?? `no access_token in ${p.name} response`);
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

/** Swap the OAuth `code` for tokens (authorization_code grant). Includes the
 *  PKCE `code_verifier` when one was used for the authorize request. */
export async function exchangeCodeForToken(
  p: OAuthProvider,
  code: string,
  creds: OAuthCredentials,
  codeVerifier?: string | null,
): Promise<OAuthTokenResponse> {
  const body: Record<string, string> = {
    client_id: creds.clientId ?? "",
    client_secret: creds.clientSecret ?? "",
    code,
    redirect_uri: redirectUri(p.name),
    grant_type: "authorization_code",
  };
  if (codeVerifier) body.code_verifier = codeVerifier;
  return postToken(p, body);
}

/** Exchange a refresh token for a fresh access token (refresh_token grant). */
export async function refreshAccessToken(
  p: OAuthProvider,
  creds: OAuthCredentials,
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  return postToken(p, {
    client_id: creds.clientId ?? "",
    client_secret: creds.clientSecret ?? "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}
