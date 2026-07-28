// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/users/users.store.ts
 *
 * Scope: the superadmin-cache invalidation wired into every write of
 * `users.is_platform_admin`. A stale `true` makes `permission.guard.ts` skip
 * EVERY permission check, so each write path is asserted individually — the
 * regression this guards against is "one caller covered, the siblings not".
 *
 * The real `superadminCache` is used (a DI-free singleton) rather than a module
 * mock, so the test fails if the store stops calling the invalidation for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted db mock — a thenable chain whose terminal value each test sets.
// ---------------------------------------------------------------------------
const { mockDb, setResult } = vi.hoisted(() => {
  let result: unknown[] = [];
  const chain = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        return () => chain;
      },
    },
  );
  return {
    mockDb: {
      insert: () => chain,
      update: () => chain,
      delete: () => chain,
    },
    setResult: (rows: unknown[]) => {
      result = rows;
    },
  };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

import { insertUser, updateUserMeta, deleteUserById } from "./users.store.js";
import { superadminCache } from "../authz/authz.caches.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

function userRow(role: "superadmin" | "user") {
  return {
    id: USER_ID,
    email: "admin@acme.com",
    name: null,
    image: null,
    role,
    mustChangePassword: false,
    passwordHash: "hash",
    createdAt: null,
    updatedAt: null,
  };
}

describe("users.store superadmin-cache invalidation", () => {
  beforeEach(() => {
    superadminCache.clear();
    setResult([]);
  });

  it("should_drop_the_cached_flag_when_updateUserMeta_changes_the_role", async () => {
    superadminCache.set(USER_ID, true);
    setResult([userRow("user")]);

    await updateUserMeta(USER_ID, { role: "user" });

    // No TTL advance: the demotion must land on the very next guard check.
    expect(superadminCache.has(USER_ID)).toBe(false);
  });

  it("should_keep_the_cached_flag_when_updateUserMeta_touches_only_the_name", async () => {
    superadminCache.set(USER_ID, true);
    setResult([userRow("superadmin")]);

    await updateUserMeta(USER_ID, { name: "New Name" });

    // The flag was not written, so there is nothing to invalidate.
    expect(superadminCache.get(USER_ID)).toBe(true);
  });

  it("should_drop_the_cached_flag_when_insertUser_writes_the_role", async () => {
    superadminCache.set(USER_ID, false);
    setResult([userRow("superadmin")]);

    await insertUser({
      email: "admin@acme.com",
      passwordHash: "hash",
      role: "superadmin",
      mustChangePassword: true,
    });

    expect(superadminCache.has(USER_ID)).toBe(false);
  });

  it("should_drop_the_cached_flag_when_deleteUserById_removes_the_row", async () => {
    superadminCache.set(USER_ID, true);
    setResult([{ id: USER_ID }]);

    await deleteUserById(USER_ID);

    expect(superadminCache.has(USER_ID)).toBe(false);
  });

  it("should_not_throw_when_deleting_a_user_that_was_never_cached", async () => {
    setResult([]);
    await expect(deleteUserById(USER_ID)).resolves.toBe(false);
    expect(superadminCache.has(USER_ID)).toBe(false);
  });
});
