// SPDX-License-Identifier: AGPL-3.0-or-later

// Generic OAuth broker: a data-driven provider registry shared by the tools that
// consume a provider (via oauth-access.ts, which builds the authorize link when a
// token is missing) and the /oauth/:provider/callback controller (swaps the code
// for a token). Adding a provider = one registry entry.
//
// Client credentials are PER-INSTANCE ONLY: read from instance_secrets under
// `<provider>_oauth_client_id` / `<provider>_oauth_client_secret` (no env
// fallback). The client_secret is resolved ONLY server-side in the callback — it
// never enters tool/LLM context. The redirect URI is computed here (once) so the
// authorize link and the token exchange always agree.
//
// ponytail: interim demo of the OAuth-per-conversation mechanism —
//   - token lands in conversation_state IN CLEARTEXT (needs the per-principal vault)
//   - `state` is the raw conversationId (no CSRF nonce / PKCE)
//   - refresh_token + expiry are discarded (Google tokens die in ~1h)
// See docs/superpowers/specs/2026-07-17-oauth-per-user-design.md.

import { randomBytes, createHash } from "crypto";
import { config } from "../../config.js";
import { getSecret } from "../../instances/secrets.store.js";
import type { InstanceSlug } from "../../instances/identifiers.js";

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

/** Static provider metadata — NO credentials (those are per-instance, resolved
 *  separately). Adding a provider is one entry here + its client credentials. */
const REGISTRY: Record<string, OAuthProvider> = {
  github: {
    name: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo read:user",
    extraAuthorizeParams: { allow_signup: "false" },
    // ponytail: GitHub OAuth App PKCE support is not clearly documented — leave
    // off (the state nonce still closes CSRF); flip to true once verified.
    pkce: false,
  },
  google: {
    name: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // openid+email identify the user; gmail.readonly reads mail; gmail.compose
    // creates drafts AND sends (covers both gmailCreateDraft and gmailSend).
    scope:
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    // access_type=offline + prompt=consent are what yield a refresh_token.
    extraAuthorizeParams: { response_type: "code", access_type: "offline", prompt: "consent" },
    pkce: true,
  },
};

export function getOAuthProvider(name: string): OAuthProvider | undefined {
  return REGISTRY[name];
}

export function knownProviderNames(): string[] {
  return Object.keys(REGISTRY);
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
  slug: InstanceSlug,
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
