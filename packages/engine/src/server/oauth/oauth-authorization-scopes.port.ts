// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OAuthProviderScope } from "./oauth-providers.js";

/**
 * The seam where a pending OAuth authorization remembers the provider scope it
 * was started in, so the callback reads the same registry the authorize link
 * was built from.
 *
 * A distribution that registers providers under a scope (see
 * `OAuthProviderScope`) registers an implementation at boot. None is registered
 * by default: every authorization belongs to the shared registry, `scopeOf`
 * answers null, and `remember` refuses a scope it could not hand back to the
 * callback, so a scoped link is never handed out that the callback would then
 * resolve in the shared registry.
 */
export interface OAuthAuthorizationScopes {
  /** Records the scope of the pending authorization behind `state`. Called
   *  after the authorization is persisted, and only for a non-null scope. */
  remember(state: string, scope: string): Promise<void>;
  /** The scope the authorization behind `state` was started in; null for the
   *  shared registry or an unknown state. Read before the state is consumed. */
  scopeOf(state: string): Promise<OAuthProviderScope>;
}

const sharedRegistryOnly: OAuthAuthorizationScopes = {
  async remember() {
    throw new Error("No OAuth authorization scope store is registered: a scoped authorization cannot be started.");
  },
  async scopeOf() {
    return null;
  },
};

let current: OAuthAuthorizationScopes = sharedRegistryOnly;

export function setOAuthAuthorizationScopes(next: OAuthAuthorizationScopes): void {
  current = next;
}

/** Test-only: drop back to the shared registry. */
export function resetOAuthAuthorizationScopes(): void {
  current = sharedRegistryOnly;
}

export function getOAuthAuthorizationScopes(): OAuthAuthorizationScopes {
  return current;
}
