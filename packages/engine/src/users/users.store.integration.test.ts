// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The user store against a real Postgres: every write of the platform-admin flag
 * drops the cached flag (a stale `true` makes the permission guard skip every
 * check), and the listing is bounded, ordered server-side and free of password
 * hashes. Self-skips when no migrated database is reachable.
 *
 * Other suites add users to the same database concurrently, so the listing is
 * judged on properties one query cannot lose to them: its own order, its bound,
 * and an offset past the end.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { platformAdminCache } from "../authz/authz.caches.js";
import { deleteUserById, insertUser, listUsers, updateUserMeta } from "./users.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-users-store";

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`;
}

const newUser = (suffix: string, isPlatformAdmin: boolean, passwordHash: string | null = "hash") =>
  insertUser({ email: `${MARKER}-${suffix}@Example.test`, passwordHash, isPlatformAdmin, mustChangePassword: false });

describe.skipIf(!DB_AVAILABLE)("user store (integration)", () => {
  beforeAll(teardown);
  afterAll(teardown);

  describe("the cached platform-admin flag", () => {
    it("is dropped when a user is created with the flag", async () => {
      // A cached `false` under the id the insert will use cannot be planted
      // before the id exists; what matters is that the write leaves no entry.
      const user = await newUser("created", true);

      expect(user.email).toBe(`${MARKER}-created@example.test`);
      expect(platformAdminCache.has(user.id)).toBe(false);
    });

    it("is dropped when the flag changes, and kept when only the name does", async () => {
      const user = await newUser("updated", true);
      platformAdminCache.set(user.id, true);

      await updateUserMeta(user.id, { name: "New Name" });
      expect(platformAdminCache.get(user.id)).toBe(true);

      await updateUserMeta(user.id, { isPlatformAdmin: false });
      expect(platformAdminCache.has(user.id)).toBe(false);
      const [row] = await queryClient<{ is_platform_admin: boolean }[]>`SELECT is_platform_admin FROM users WHERE id = ${user.id}`;
      expect(row!.is_platform_admin).toBe(false);
    });

    it("is dropped when the user is deleted, and deleting an unknown user reports false", async () => {
      const user = await newUser("deleted", true);
      platformAdminCache.set(user.id, true);

      expect(await deleteUserById(user.id)).toBe(true);
      expect(platformAdminCache.has(user.id)).toBe(false);
      expect(await deleteUserById(user.id)).toBe(false);
    });
  });

  describe("the listing", () => {
    beforeAll(async () => {
      await newUser("list-b", false);
      await newUser("list-a", false, null);
      await newUser("list-z-admin", true);
    });

    it("orders platform admins first, then by email, without password hashes", async () => {
      const { users: all, total } = await listUsers({ limit: 100_000, offset: 0 });

      expect(total).toBeGreaterThanOrEqual(3);
      // Admins first across everyone; the email order is checked on this file's
      // users only, whose order does not depend on the database's collation.
      const firstNonAdmin = all.findIndex((u) => !u.isPlatformAdmin);
      expect(all.slice(firstNonAdmin === -1 ? all.length : firstNonAdmin).every((u) => !u.isPlatformAdmin)).toBe(true);
      const mine = all.filter((u) => u.email.startsWith(`${MARKER}-list`));
      expect(mine.map((u) => u.email)).toEqual([
        `${MARKER}-list-z-admin@example.test`,
        `${MARKER}-list-a@example.test`,
        `${MARKER}-list-b@example.test`,
      ]);
      for (const u of all) expect(u).not.toHaveProperty("passwordHash");
      expect(mine.map((u) => u.hasPassword)).toEqual([true, false, true]);
    });

    it("returns at most the page asked for, and nothing past the end, with the total", async () => {
      const first = await listUsers({ limit: 2, offset: 0 });
      expect(first.users).toHaveLength(2);
      expect(first.total).toBeGreaterThanOrEqual(3);

      const past = await listUsers({ limit: 5, offset: 1_000_000 });
      expect(past.users).toEqual([]);
      expect(past.total).toBeGreaterThanOrEqual(3);
    });
  });
});
