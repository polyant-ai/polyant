// SPDX-License-Identifier: AGPL-3.0-or-later

// Server-side refresh-aware access-token accessor. Reads the encrypted vault,
// returns a valid access token, and transparently refreshes an expired one using
// the stored refresh token. Lives server-side (NOT on ctx) because refresh needs
// the client_secret (via resolveOAuthCredentials → getSecret) + a vault write —
// neither of which may enter tool/LLM context.

import type { AgentSlug } from "../../instances/identifiers.js";
import { getPrincipalSecret, setPrincipalSecret } from "../../conversations/principal-secrets.store.js";
import {
  getOAuthProvider,
  resolveOAuthCredentials,
  refreshAccessToken,
  oauthTokenStateKey,
  oauthRefreshStateKey,
} from "./oauth-providers.js";

// Refresh a bit BEFORE expiry so an in-flight call doesn't race the deadline.
const EXPIRY_SKEW_MS = 60_000;

/** True when a token with the given expiry should be refreshed now. A null
 *  expiry means "never expires" (e.g. GitHub) → never refresh. */
export function needsRefresh(expiresAt: Date | null, now: number, skewMs = EXPIRY_SKEW_MS): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - skewMs <= now;
}

/**
 * A valid access token for the provider on this conversation, refreshing if
 * needed. Returns null when there is no token, or when a needed refresh is not
 * possible/failed — the caller then surfaces a fresh connect link.
 */
export async function getValidAccessToken(
  slug: AgentSlug,
  conversationId: string,
  providerName: string,
): Promise<string | null> {
  const access = await getPrincipalSecret(conversationId, oauthTokenStateKey(providerName));
  if (!access) return null;
  if (!needsRefresh(access.expiresAt, Date.now())) return access.value;

  const refresh = await getPrincipalSecret(conversationId, oauthRefreshStateKey(providerName));
  const provider = getOAuthProvider(providerName);
  if (!refresh || !provider) return null;

  const creds = await resolveOAuthCredentials(providerName, slug);
  if (!creds.clientId || !creds.clientSecret) return null;

  try {
    const res = await refreshAccessToken(provider, creds, refresh.value);
    const expiresAt = res.expiresIn ? new Date(Date.now() + res.expiresIn * 1000) : null;
    await setPrincipalSecret(conversationId, slug, oauthTokenStateKey(providerName), res.accessToken, expiresAt);
    // Google may omit refresh_token on refresh — only overwrite when present so
    // the original long-lived refresh token isn't clobbered with undefined.
    if (res.refreshToken) {
      await setPrincipalSecret(conversationId, slug, oauthRefreshStateKey(providerName), res.refreshToken, null);
    }
    return res.accessToken;
  } catch {
    return null;
  }
}
