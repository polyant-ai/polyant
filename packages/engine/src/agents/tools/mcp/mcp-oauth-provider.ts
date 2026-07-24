// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OAuthClientProvider, OAuthClientInformation, OAuthClientMetadata, OAuthTokens } from "@ai-sdk/mcp";
import { generateToken } from "../../../crypto/index.js";
import { config } from "../../../config.js";
import { type InstanceUuid } from "../../../instances/identifiers.js";
import { getPrincipalSecret, setPrincipalSecret } from "../../../conversations/principal-secrets.store.js";
import { createOAuthState } from "../../../server/oauth/oauth-states.store.js";
import { mergeMcpServerConfig } from "../../../instances/mcp-servers.store.js";
import type { McpServerConfig } from "../../../instances/mcp-servers.store.js";

/** `<baseUrl>/mcp/oauth/callback` — the single redirect URI registered for every MCP server. */
export function mcpRedirectUrl(): string {
  const base = config.server.baseUrl ?? `http://localhost:${config.server.port}`;
  return `${base.replace(/\/+$/, "")}/mcp/oauth/callback`;
}

export interface McpOAuthProviderDeps {
  instanceUuid: InstanceUuid;
  conversationId: string;
  serverSlug: string;
  config: McpServerConfig;
}

const tokensKey = (slug: string) => `mcp_${slug}_tokens`;
const verifierKey = (slug: string) => `mcp_${slug}_verifier`;

/**
 * Vault-backed `OAuthClientProvider` for `@ai-sdk/mcp`'s `auth()` — storage only,
 * the SDK drives discovery/DCR/PKCE/token-exchange itself.
 *
 * Step-0 finding (verified against node_modules/@ai-sdk/mcp/dist/index.mjs
 * `authInternal()`): `saveState()` is only ever invoked by the SDK when
 * `provider.state()` first returns a truthy nonce —
 * `const state = provider.state ? await provider.state() : void 0;
 *  if (state && provider.saveState) await provider.saveState(state);`.
 * A provider that implements only `saveState()`/`storedState()` (no `state()`)
 * never gets a CSRF nonce generated, so `saveState` is dead code and no
 * `oauth_states` row is ever written. `state()` must therefore be implemented
 * here; it only generates + returns the nonce; persistence stays in
 * `saveState()`, which the SDK calls immediately after.
 */
export class McpVaultOAuthProvider implements OAuthClientProvider {
  public pendingAuthorizeUrl?: string;
  private stateValue?: string;

  constructor(private readonly deps: McpOAuthProviderDeps) {}

  get redirectUrl(): string {
    return mcpRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    const cfg = this.deps.config as { scopes?: string[]; staticClient?: { clientSecret?: string } };
    return {
      redirect_uris: [this.redirectUrl],
      client_name: `Polyant (${this.deps.serverSlug})`,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: cfg.staticClient?.clientSecret ? "client_secret_post" : "none",
      scope: cfg.scopes?.join(" "),
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const cfg = this.deps.config as {
      dcrClient?: OAuthClientInformation;
      staticClient?: { clientId: string; clientSecret?: string };
    };
    if (cfg.dcrClient) return cfg.dcrClient;
    if (cfg.staticClient) return { client_id: cfg.staticClient.clientId, client_secret: cfg.staticClient.clientSecret };
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    await mergeMcpServerConfig(this.deps.instanceUuid, this.deps.serverSlug, { dcrClient: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await getPrincipalSecret(this.deps.conversationId, tokensKey(this.deps.serverSlug));
    return row ? (JSON.parse(row.value) as OAuthTokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await setPrincipalSecret(this.deps.conversationId, this.deps.instanceUuid, tokensKey(this.deps.serverSlug), JSON.stringify(tokens));
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await setPrincipalSecret(this.deps.conversationId, this.deps.instanceUuid, verifierKey(this.deps.serverSlug), verifier);
  }

  async codeVerifier(): Promise<string> {
    const row = await getPrincipalSecret(this.deps.conversationId, verifierKey(this.deps.serverSlug));
    if (!row) throw new Error(`Missing PKCE verifier for mcp:${this.deps.serverSlug}`);
    return row.value;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizeUrl = authorizationUrl.toString();
  }

  /** Generates the CSRF nonce; the SDK persists it via saveState() right after. */
  state(): string {
    return generateToken(16);
  }

  async saveState(state: string): Promise<void> {
    this.stateValue = state;
    await createOAuthState({
      state,
      conversationId: this.deps.conversationId,
      instanceId: this.deps.instanceUuid,
      provider: `mcp:${this.deps.serverSlug}`,
      codeVerifier: null,
    });
  }

  async storedState(): Promise<string | undefined> {
    return this.stateValue;
  }

  /** Seeded by the OAuth callback (Task 9) after it consumes the oauth_states row,
   *  on a freshly-constructed provider — so storedState() matches the callback's state. */
  setStoredState(state: string): void {
    this.stateValue = state;
  }
}

export function makeMcpOAuthProvider(deps: McpOAuthProviderDeps): McpVaultOAuthProvider {
  return new McpVaultOAuthProvider(deps);
}
