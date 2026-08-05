// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for `promotePlatformAdminByEmail` — the `PLATFORM_ADMIN_EMAIL` boot
 * path, and the one write of `users.is_platform_admin` that the
 * invalidate-on-every-write sweep missed.
 *
 * It used to set the FLAG alone. Two things followed, both invisible:
 *
 *  - the account became a total permission-guard bypass that `GET /api/users`
 *    renders as an ordinary user, and that `@RequireRole(platform_admin)` locks
 *    out of the users admin page it is supposedly an admin of;
 *  - `role`/flag divergence, which migration 0071's original two-way
 *    reconciliation resolved by REVOKING the flag — silently removing platform
 *    admin from exactly the accounts this function had promoted.
 *
 * The real `platformAdminCache` is used rather than a module mock, so these fail
 * if the store stops invalidating for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  setReturning,
  setExistingBindings,
  bindingsAfterBootstrap,
  deleteTargetsOrganizationScope,
  updateCalls,
  transactionCount,
} = vi.hoisted(() => {
  let returning: unknown[] = [];
  let transactions = 0;
  let pendingBindingDelete = false;
  let bindingRows: Array<{
    roleId: string;
    scopeType: "organization" | "workspace";
  }> = [];
  let bindingDeleteTargetsOrganizationScope = false;
  let transactionExecutor: unknown;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  /**
   * Drizzle represents `eq(column, value)` as one SQL object whose direct
   * query chunks contain both the column and the Param value. Looking for those
   * two direct children prevents `organization_id` in a different predicate
   * from being mistaken for `scope_type = 'organization'`.
   */
  const hasOrganizationScopeEquality = (
    value: unknown,
    seen = new Set<unknown>(),
  ): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);

    const record = value as { queryChunks?: unknown[] };
    const chunks = record.queryChunks;
    if (Array.isArray(chunks)) {
      const hasScopeTypeColumn = chunks.some(
        (chunk) =>
          !!chunk &&
          typeof chunk === "object" &&
          (chunk as { name?: unknown }).name === "scope_type",
      );
      const hasOrganizationParam = chunks.some(
        (chunk) =>
          !!chunk &&
          typeof chunk === "object" &&
          (chunk as { value?: unknown }).value === "organization",
      );
      if (hasScopeTypeColumn && hasOrganizationParam) return true;
    }

    return Object.values(value).some((child) =>
      hasOrganizationScopeEquality(child, seen),
    );
  };
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(returning);
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          if (prop === "where" && pendingBindingDelete) {
            bindingDeleteTargetsOrganizationScope =
              hasOrganizationScopeEquality(args[0]);
            bindingRows = bindingDeleteTargetsOrganizationScope
              ? bindingRows.filter((binding) => binding.scopeType !== "organization")
              : [];
            pendingBindingDelete = false;
          }
          if (prop === "values") {
            const value = args[0] as {
              roleId?: string;
              scopeType?: "organization" | "workspace";
            };
            if (value.roleId && value.scopeType) {
              bindingRows.push({ roleId: value.roleId, scopeType: value.scopeType });
            }
          }
          return chain;
        };
      },
    },
  );
  const database = {
      update: () => chain,
      select: () => chain,
      insert: () => chain,
      delete: () => {
        pendingBindingDelete = true;
        return chain;
      },
      transaction: async (callback: (tx: unknown) => unknown) => {
        transactions += 1;
        return callback(transactionExecutor);
      },
  };
  transactionExecutor = database;
  return {
    mockDb: database,
    setReturning: (rows: unknown[]) => {
      returning = rows;
      calls.length = 0;
      transactions = 0;
      pendingBindingDelete = false;
      bindingDeleteTargetsOrganizationScope = false;
    },
    setExistingBindings: (
      bindings: Array<{ roleId: string; scopeType: "organization" | "workspace" }>,
    ) => {
      bindingRows = [...bindings];
    },
    bindingsAfterBootstrap: () => [...bindingRows],
    deleteTargetsOrganizationScope: () => bindingDeleteTargetsOrganizationScope,
    updateCalls: calls,
    transactionCount: () => transactions,
  };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

import {
  ensureConfiguredPlatformAdminOwner,
  promotePlatformAdminByEmail,
} from "./organizations.store.js";
import {
  bindingCache,
  bindingCacheKey,
  platformAdminCache,
} from "../authz/authz.caches.js";
import { PLATFORM_ADMIN_ROLE } from "../auth/user-role.js";

const USER_ID = "22222222-2222-2222-2222-222222222222";

/** The values handed to `.set(...)`, which is where the defect lived. */
function patch(): Record<string, unknown> {
  const call = updateCalls.find((c) => c.method === "set");
  expect(call, "promotePlatformAdminByEmail must issue an update").toBeDefined();
  return call!.args[0] as Record<string, unknown>;
}

describe("promotePlatformAdminByEmail", () => {
  beforeEach(() => {
    platformAdminCache.clear();
    setReturning([{ id: USER_ID }]);
  });

  it("sets the ROLE as well as the flag", async () => {
    await promotePlatformAdminByEmail("ops@acme.com");

    // The flag alone is what produced an admin the UI showed as a plain user.
    expect(patch().isPlatformAdmin).toBe(true);
    expect(patch().role).toBe(PLATFORM_ADMIN_ROLE);
  });

  it("drops the cached flag so the promotion is not hidden by a stale false", async () => {
    platformAdminCache.set(USER_ID, false);

    await promotePlatformAdminByEmail("ops@acme.com");

    // No TTL advance: the promotion must land on the very next guard check.
    expect(platformAdminCache.has(USER_ID)).toBe(false);
  });

  it("reports how many rows it promoted", async () => {
    await expect(promotePlatformAdminByEmail("ops@acme.com")).resolves.toBe(1);
  });

  it("is a no-op for an unknown email, and caches nothing", async () => {
    setReturning([]);

    await expect(promotePlatformAdminByEmail("nobody@acme.com")).resolves.toBe(0);
    expect(platformAdminCache.has(USER_ID)).toBe(false);
  });
});

describe("ensureConfiguredPlatformAdminOwner", () => {
  beforeEach(() => {
    platformAdminCache.clear();
    bindingCache.clear();
    setReturning([{ id: USER_ID, isPlatformAdmin: false }]);
    setExistingBindings([]);
  });

  it("updates the configured user and grants default-org owner access atomically", async () => {
    platformAdminCache.set(USER_ID, false);
    bindingCache.set(bindingCacheKey(USER_ID, USER_ID), []);

    await expect(ensureConfiguredPlatformAdminOwner("Boss@Example.com")).resolves.toBe(
      USER_ID,
    );

    expect(transactionCount()).toBe(1);
    expect(patch().isPlatformAdmin).toBe(true);
    expect(patch().role).toBe(PLATFORM_ADMIN_ROLE);
    expect(platformAdminCache.has(USER_ID)).toBe(false);
    expect(bindingCache.has(bindingCacheKey(USER_ID, USER_ID))).toBe(false);
  });

  it("replaces only org bindings and preserves workspace policy", async () => {
    setExistingBindings([
      { roleId: "admin-role", scopeType: "organization" },
      { roleId: "member-role", scopeType: "organization" },
      { roleId: "workspace-admin", scopeType: "workspace" },
    ]);

    await ensureConfiguredPlatformAdminOwner("boss@example.com");

    expect(deleteTargetsOrganizationScope()).toBe(true);
    expect(bindingsAfterBootstrap()).toEqual([
      { roleId: "workspace-admin", scopeType: "workspace" },
      { roleId: USER_ID, scopeType: "organization" },
    ]);
  });
});
