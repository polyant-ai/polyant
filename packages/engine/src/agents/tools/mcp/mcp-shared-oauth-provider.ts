// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OAuthTokens } from "@ai-sdk/mcp";
import { McpVaultOAuthProvider } from "./mcp-oauth-provider.js";
import { createOAuthState } from "../../../server/oauth/oauth-states.store.js";
import {
  clearMcpSharedTokens,
  getMcpSharedTokens,
  saveMcpSharedTokens,
  type McpServerConfig,
} from "../../../instances/mcp-servers.store.js";
import type { InstanceSlug, InstanceUuid } from "../../../instances/identifiers.js";

/** The `oauth_states.provider` value of an authorization started from the panel. */
export const MCP_SHARED_STATE_PREFIX = "mcp-shared:";

/** Thrown when a turn would need someone to authorize the shared account. */
export class McpSharedAccountNotConnectedError extends Error {
  constructor(serverSlug: string) {
    super(`The shared account of MCP server '${serverSlug}' is not connected; an admin has to connect it from the panel`);
    this.name = "McpSharedAccountNotConnectedError";
  }
}

/**
 * The three moments of a shared account, each with its own storage:
 *
 * - `turn`: a conversation uses the connected account. Tokens come from the
 *   server row and a refresh writes back there. Nobody in the conversation may
 *   authorize it, so starting an authorization is an error, never a link.
 * - `authorize`: an admin starts the connection from the panel. Stored tokens
 *   are ignored, so connecting again always asks the provider, and the PKCE
 *   verifier rides in the `oauth_states` row with the admin's user id.
 * - `callback`: the provider redirects back. The verifier and the admin come
 *   from that consumed row, and the tokens land on the server row.
 *
 * `oauth_states.conversation_id` carries the admin's user id for these rows:
 * there is no conversation, the column is NOT NULL, and the provider prefix
 * tells the callback which of the two it holds.
 */
export type McpSharedOAuthMode =
  | { kind: "turn" }
  | { kind: "authorize"; actorUserId: string | null }
  | { kind: "callback"; actorUserId: string | null; codeVerifier: string };

export interface McpSharedOAuthProviderDeps {
  instanceUuid: InstanceUuid;
  instanceSlug: InstanceSlug;
  serverSlug: string;
  config: McpServerConfig;
  baseUrl: string;
  mode: McpSharedOAuthMode;
}

export class McpSharedOAuthProvider extends McpVaultOAuthProvider {
  private pendingState?: string;

  constructor(private readonly shared: McpSharedOAuthProviderDeps) {
    // The conversation-keyed members of the parent are all overridden below,
    // so its conversation id is never read.
    super({ ...shared, conversationId: "" });
  }

  override async tokens(): Promise<OAuthTokens | undefined> {
    if (this.shared.mode.kind === "authorize") return undefined;
    const stored = await getMcpSharedTokens(this.shared.instanceUuid, this.shared.serverSlug);
    return stored ? (JSON.parse(stored) as OAuthTokens) : undefined;
  }

  override async saveTokens(tokens: OAuthTokens): Promise<void> {
    const mode = this.shared.mode;
    await saveMcpSharedTokens(
      this.shared.instanceUuid,
      this.shared.serverSlug,
      JSON.stringify(tokens),
      mode.kind === "callback" ? { by: mode.actorUserId } : undefined,
    );
  }

  override async saveState(state: string): Promise<void> {
    this.pendingState = state;
  }

  override async saveCodeVerifier(verifier: string): Promise<void> {
    const mode = this.shared.mode;
    if (mode.kind !== "authorize" || !this.pendingState) {
      throw new McpSharedAccountNotConnectedError(this.shared.serverSlug);
    }
    await createOAuthState({
      state: this.pendingState,
      conversationId: mode.actorUserId ?? "",
      instanceId: this.shared.instanceUuid,
      provider: `${MCP_SHARED_STATE_PREFIX}${this.shared.serverSlug}`,
      codeVerifier: verifier,
    });
  }

  override async codeVerifier(): Promise<string> {
    if (this.shared.mode.kind !== "callback") throw new McpSharedAccountNotConnectedError(this.shared.serverSlug);
    return this.shared.mode.codeVerifier;
  }

  /**
   * The SDK calls this when the provider answers `invalid_grant`: the refresh
   * token is dead and no retry can revive it, so the account reads as
   * disconnected until an admin connects it again. `context.tokens` are the
   * tokens that refresh used; they are cleared only if still stored, because
   * a provider that rotates refresh tokens refuses the loser of two concurrent
   * refreshes while the winner's tokens are good.
   */
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier",
    context?: { tokens: OAuthTokens },
  ): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      await clearMcpSharedTokens(this.shared.instanceUuid, this.shared.serverSlug, context?.tokens);
    }
  }
}
