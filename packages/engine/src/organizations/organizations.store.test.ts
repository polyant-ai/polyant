// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for `ensureExistingPlatformAdminOwner` — the boot path that makes
 * the seeded initial admin an Owner of the default organization, and the only
 * bootstrap identity there is.
 *
 * Two properties matter and both used to be violated by an earlier shape of
 * this code: it must REFUSE an account that is not already a platform admin
 * (nothing here may elevate an address by configuration), and it must replace
 * only ORGANIZATION-scoped bindings, leaving workspace policy alone.
 *
 * The real `bindingCache` is used rather than a module mock, so these fail if
 * the store stops invalidating for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  setReturning,
  setExistingBindings,
  bindingsAfterBootstrap,
  deleteTargetsOrganizationScope,
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
        return callback(database);
      },
  };
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

import { ensureExistingPlatformAdminOwner } from "./organizations.store.js";
import { bindingCache, bindingCacheKey } from "../authz/authz.caches.js";

const USER_ID = "22222222-2222-2222-2222-222222222222";

describe("ensureExistingPlatformAdminOwner", () => {
  beforeEach(() => {
    bindingCache.clear();
    setReturning([{ id: USER_ID, isPlatformAdmin: true }]);
    setExistingBindings([]);
  });

  it("grants default-org owner access atomically, matching the email case-insensitively", async () => {
    bindingCache.set(bindingCacheKey(USER_ID, USER_ID), []);

    await expect(ensureExistingPlatformAdminOwner("Boss@Example.com")).resolves.toBe(
      USER_ID,
    );

    expect(transactionCount()).toBe(1);
    expect(bindingCache.has(bindingCacheKey(USER_ID, USER_ID))).toBe(false);
  });

  it("refuses an account that is not already a platform admin", async () => {
    // Nothing on this path may elevate an address named by configuration: the
    // seeder is what makes the account privileged, and it does so on insert.
    setReturning([{ id: USER_ID, isPlatformAdmin: false }]);

    await expect(ensureExistingPlatformAdminOwner("boss@example.com")).resolves.toBeNull();
  });

  it("replaces only org bindings and preserves workspace policy", async () => {
    setExistingBindings([
      { roleId: "admin-role", scopeType: "organization" },
      { roleId: "member-role", scopeType: "organization" },
      { roleId: "workspace-admin", scopeType: "workspace" },
    ]);

    await ensureExistingPlatformAdminOwner("boss@example.com");

    expect(deleteTargetsOrganizationScope()).toBe(true);
    expect(bindingsAfterBootstrap()).toEqual([
      { roleId: "workspace-admin", scopeType: "workspace" },
      { roleId: USER_ID, scopeType: "organization" },
    ]);
  });
});
