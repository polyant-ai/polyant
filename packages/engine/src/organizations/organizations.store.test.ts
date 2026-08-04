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

const { mockDb, setReturning, updateCalls } = vi.hoisted(() => {
  let returning: unknown[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(returning);
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return chain;
        };
      },
    },
  );
  return {
    mockDb: { update: () => chain, select: () => chain, insert: () => chain },
    setReturning: (rows: unknown[]) => {
      returning = rows;
      calls.length = 0;
    },
    updateCalls: calls,
  };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

import { promotePlatformAdminByEmail } from "./organizations.store.js";
import { platformAdminCache } from "../authz/authz.caches.js";
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
