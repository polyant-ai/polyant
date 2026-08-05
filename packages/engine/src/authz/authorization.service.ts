// SPDX-License-Identifier: AGPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import {
  bindingCache,
  bindingCacheKey,
  superadminCache,
} from "./authz.caches.js";
import {
  readAgentScope,
  readPlatformAdminFlag,
  readUserBindings,
  type AgentScope,
  type EffectiveBinding,
} from "./authz.store.js";
import {
  AUTHORIZATION_STRATEGY,
  type AuthorizationStrategy,
} from "./authorization-strategy.js";
import type { PermissionKey } from "./permissions.js";

/**
 * Central authorization façade (design §6.1). Wraps the pluggable strategy with
 * the two RBAC caches and the DB store, exposing the four operations the guard
 * and the management plane need:
 *
 *   - `can()`              — most-specific-wins permission check for a scope.
 *   - `isPlatformAdmin()`  — DB-backed, cached superadmin bypass check.
 *   - `resolveAgentScope()`— the single agent-slug → tenancy choke-point.
 *   - `invalidateBindingCache()` — eager flush after a binding mutation.
 *
 * It never reads the DB when a fresh cache entry exists, so the guard stays off
 * the hot path for repeated checks within a TTL window.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(AUTHORIZATION_STRATEGY)
    private readonly strategy: AuthorizationStrategy,
  ) {}

  /** Whether `userId` may perform `permission` against the given agent scope. */
  async can(
    userId: string,
    scope: AgentScope,
    permission: PermissionKey,
  ): Promise<boolean> {
    const bindings = await this.loadBindings(userId, scope.organizationId);
    return this.strategy.resolve(bindings, scope, permission);
  }

  /** DB-backed, 5-minute-cached platform-admin (superadmin) check. */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const cached = superadminCache.get(userId);
    if (cached !== undefined) return cached;

    const isAdmin = await readPlatformAdminFlag(userId);
    superadminCache.set(userId, isAdmin);
    return isAdmin;
  }

  /** The single sanctioned agent-slug → tenancy scope translation. */
  async resolveAgentScope(agentSlug: string): Promise<AgentScope | null> {
    return readAgentScope(agentSlug);
  }

  /** Drop the cached bindings for a user+org (call after a binding mutation). */
  invalidateBindingCache(userId: string, organizationId: string): void {
    bindingCache.delete(bindingCacheKey(userId, organizationId));
  }

  // -- internal ---------------------------------------------------------------

  private async loadBindings(
    userId: string,
    organizationId: string,
  ): Promise<EffectiveBinding[]> {
    const key = bindingCacheKey(userId, organizationId);
    const cached = bindingCache.get(key);
    if (cached !== undefined) return cached;

    const bindings = await readUserBindings(userId, organizationId);
    bindingCache.set(key, bindings);
    return bindings;
  }
}
