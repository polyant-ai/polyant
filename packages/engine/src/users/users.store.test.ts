// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/users/users.store.ts
 *
 * Scope: the platform admin-cache invalidation wired into every write of
 * `users.is_platform_admin`. A stale `true` makes `permission.guard.ts` skip
 * EVERY permission check, so each write path is asserted individually — the
 * regression this guards against is "one caller covered, the siblings not".
 *
 * The real `platformAdminCache` is used (a DI-free singleton) rather than a module
 * mock, so the test fails if the store stops calling the invalidation for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted db mock — a thenable chain whose terminal value each test sets.
// ---------------------------------------------------------------------------
const { mockDb, setResult, setPage, selectCalls } = vi.hoisted(() => {
  let result: unknown[] = [];
  let pageRows: unknown[] = [];
  let pageTotal = 0;
  const calls: Array<{ method: string; args: unknown[] }> = [];
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

  /** A read chain that RECORDS what was called on it, so a test can assert the
   *  query was actually bounded rather than trusting the store's source. */
  function readChain(rows: unknown[]): unknown {
    const recorder: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(rows);
          return (...args: unknown[]) => {
            calls.push({ method: prop, args });
            return recorder;
          };
        },
      },
    );
    return recorder;
  }

  return {
    mockDb: {
      insert: () => chain,
      update: () => chain,
      delete: () => chain,
      // A count projection and a row select share one `db.select`, so the two
      // are told apart by the projection itself — the alternative, one shared
      // terminal value, cannot answer both queries of a `Promise.all`.
      select: (projection?: Record<string, unknown>) =>
        readChain(projection && "count" in projection ? [{ count: pageTotal }] : pageRows),
    },
    setResult: (rows: unknown[]) => {
      result = rows;
    },
    setPage: (rows: unknown[], total: number) => {
      pageRows = rows;
      pageTotal = total;
      calls.length = 0;
    },
    selectCalls: calls,
  };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

import { insertUser, updateUserMeta, deleteUserById, listUsers } from "./users.store.js";
import { platformAdminCache } from "../authz/authz.caches.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Serialize a Drizzle expression so a test can assert on the literals inside it.
 * A plain `JSON.stringify` throws — the column objects hold back-references to
 * their table — and a throw here reads as an assertion failure, which sent this
 * test's first version chasing the wrong cause.
 */
function stringifySql(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "object" && entry !== null) {
      if (seen.has(entry)) return "[circular]";
      seen.add(entry);
    }
    return entry;
  });
}

function userRow(role: "platform_admin" | "user", isPlatformAdmin = role === "platform_admin") {
  return {
    id: USER_ID,
    email: "admin@acme.com",
    name: null,
    image: null,
    role,
    // The enforced column. Defaults to agreeing with the role, but the two are
    // separately settable here because the interesting cases are the ones where
    // they DISAGREE — that divergence is what the last-admin guard missed.
    isPlatformAdmin,
    mustChangePassword: false,
    passwordHash: "hash",
    createdAt: null,
    updatedAt: null,
  };
}

describe("users.store platform admin-cache invalidation", () => {
  beforeEach(() => {
    platformAdminCache.clear();
    setResult([]);
  });

  it("should_drop_the_cached_flag_when_updateUserMeta_changes_the_role", async () => {
    platformAdminCache.set(USER_ID, true);
    setResult([userRow("user")]);

    await updateUserMeta(USER_ID, { role: "user" });

    // No TTL advance: the demotion must land on the very next guard check.
    expect(platformAdminCache.has(USER_ID)).toBe(false);
  });

  it("should_keep_the_cached_flag_when_updateUserMeta_touches_only_the_name", async () => {
    platformAdminCache.set(USER_ID, true);
    setResult([userRow("platform_admin")]);

    await updateUserMeta(USER_ID, { name: "New Name" });

    // The flag was not written, so there is nothing to invalidate.
    expect(platformAdminCache.get(USER_ID)).toBe(true);
  });

  it("should_drop_the_cached_flag_when_insertUser_writes_the_role", async () => {
    platformAdminCache.set(USER_ID, false);
    setResult([userRow("platform_admin")]);

    await insertUser({
      email: "admin@acme.com",
      passwordHash: "hash",
      role: "platform_admin",
      mustChangePassword: true,
    });

    expect(platformAdminCache.has(USER_ID)).toBe(false);
  });

  it("should_drop_the_cached_flag_when_deleteUserById_removes_the_row", async () => {
    platformAdminCache.set(USER_ID, true);
    setResult([{ id: USER_ID }]);

    await deleteUserById(USER_ID);

    expect(platformAdminCache.has(USER_ID)).toBe(false);
  });

  it("should_not_throw_when_deleting_a_user_that_was_never_cached", async () => {
    setResult([]);
    await expect(deleteUserById(USER_ID)).resolves.toBe(false);
    expect(platformAdminCache.has(USER_ID)).toBe(false);
  });
});

describe("listUsers is bounded", () => {
  it("should_apply_the_requested_limit_and_offset_and_report_the_total", async () => {
    setPage([userRow("user")], 137);

    const page = await listUsers({ limit: 25, offset: 50 });

    // The total is what makes a page navigable: without it the caller cannot
    // tell a short last page from the end of the table.
    expect(page.total).toBe(137);
    expect(page.users).toHaveLength(1);
    // Asserted on the CHAIN, not on the source: an unbounded select is the
    // defect, so the test has to see the bound actually applied.
    expect(selectCalls).toContainEqual({ method: "limit", args: [25] });
    expect(selectCalls).toContainEqual({ method: "offset", args: [50] });
  });

  it("should_order_server_side_so_a_page_is_not_an_arbitrary_slice", async () => {
    setPage([], 0);

    await listUsers({ limit: 25, offset: 0 });

    // The page used to sort platform-admins-first in the browser over the whole
    // list. Paginate on the wire without moving the order and page 1 becomes
    // whatever the planner returned.
    //
    // Asserted on the RENDERED SQL, not on `args.length === 2`. Arity alone
    // passes for any two order terms — including a version that dropped the
    // legacy-spelling tolerance, which is the part that actually decides whether
    // a row still holding `superadmin` sorts in with ordinary users.
    const orderBy = selectCalls.find((c) => c.method === "orderBy");
    expect(orderBy, "listUsers must order server-side").toBeDefined();
    const rendered = stringifySql(orderBy!.args);
    expect(rendered).toContain("platform_admin");
    expect(rendered).toContain("superadmin");
  });

  it("should_never_leak_the_password_hash_into_a_listing", async () => {
    setPage([userRow("platform_admin")], 1);

    const page = await listUsers({ limit: 25, offset: 0 });

    expect(page.users[0]).not.toHaveProperty("passwordHash");
    expect(page.users[0].hasPassword).toBe(true);
  });
});
