// SPDX-License-Identifier: AGPL-3.0-or-later

import { TtlCache } from "../utils/ttl-cache.js";
import type { EffectiveBinding } from "./authz.store.js";

/**
 * RBAC in-memory caches (design §6.2). Both are process-local TTL caches — a
 * stale entry self-heals within its window, so a binding change or a superadmin
 * revocation takes effect after at most the TTL without an explicit flush. The
 * `AuthorizationService.invalidateBindingCache()` choke-point clears entries
 * eagerly when a mutation is known (e.g. a role-binding write).
 */

/** Effective bindings live 60 s — short enough that revocation is near-instant. */
export const BINDING_CACHE_TTL_MS = 60_000;

/** Platform-admin status lives 5 min — read rarely, changes very rarely. */
export const SUPERADMIN_CACHE_TTL_MS = 5 * 60_000;

/**
 * Keyed by `${userId}:${organizationId}` → the user's effective bindings in
 * that org. Bounded so a burst of distinct users cannot grow it unbounded.
 */
export const bindingCache = new TtlCache<string, EffectiveBinding[]>({
  maxSize: 1_000,
  ttlMs: BINDING_CACHE_TTL_MS,
});

/** Keyed by `userId` → whether the user is a platform admin. */
export const superadminCache = new TtlCache<string, boolean>({
  maxSize: 1_000,
  ttlMs: SUPERADMIN_CACHE_TTL_MS,
});

/** Compose the binding-cache key from its parts (single source of the format). */
export function bindingCacheKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}
