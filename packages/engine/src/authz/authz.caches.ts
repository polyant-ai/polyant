// SPDX-License-Identifier: AGPL-3.0-or-later

import { TtlCache } from "../utils/ttl-cache.js";
import type { EffectiveBinding } from "./authz.store.js";

/**
 * RBAC in-memory caches (design §6.2). Both are process-local TTL caches — a
 * stale entry self-heals within its window, so a missed invalidation degrades
 * to "takes effect after at most the TTL" instead of never. The TTL is the
 * safety net, not the contract: every known mutation flushes eagerly through a
 * choke-point — `AuthorizationService.invalidateBindingCache()` for bindings,
 * `invalidateSuperadminCache()` for the platform-admin flag.
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
export const platformAdminCache = new TtlCache<string, boolean>({
  maxSize: 1_000,
  ttlMs: SUPERADMIN_CACHE_TTL_MS,
});

/**
 * Drop the cached platform-admin flag for one user, so a revocation is honoured
 * on the very next request instead of up to SUPERADMIN_CACHE_TTL_MS later — the
 * bypass in `permission.guard.ts` skips every permission check, so a stale
 * `true` is a 5-minute authorization hole.
 *
 * Exported as a plain function rather than only as an `AuthorizationService`
 * method because the write side lives in `users.store.ts`, and NestJS DI is
 * confined to `server/` in this codebase — a store must not inject a service.
 * This module is already a DI-free singleton, so it is the natural seam; the
 * service keeps a thin delegate for guard-side (DI) callers, mirroring
 * `invalidateBindingCache`.
 */
export function invalidateSuperadminCache(userId: string): void {
  platformAdminCache.delete(userId);
}

/** Compose the binding-cache key from its parts (single source of the format). */
export function bindingCacheKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}
