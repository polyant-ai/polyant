// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the RBAC tenancy schema as the WHOLE migration chain
 * leaves it — 0051 seeds the org, workspaces, roles and bindings, and 0075
 * drops `users.role` after reconciling it into `is_platform_admin`. Exercises
 * the live seed, backfill, scope trigger and idempotency against a migrated
 * Postgres.
 *
 * Every query here must be valid against the schema AFTER the last migration,
 * not after the one it is named for: CI migrates first and then runs this
 * suite, so a column an intermediate migration dropped raises 42703 rather
 * than failing an assertion. That is what a reader of `users.role` did here.
 *
 * Self-skips when no migrated database is reachable (so a bare `npm test`
 * without a DB stays green). Run it for real with a database up:
 *   docker compose up -d postgres && npm run db:migrate && npm run test:integration
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, afterEach } from "vitest";
import { queryClient } from "../database/client.js";
import { SYSTEM_ROLE_PERMISSIONS, SYSTEM_ROLE_KEYS } from "../authz/permissions.js";


const DB_AVAILABLE = await resolveDatabaseAvailability();

/** UUID of the seeded default org (assumed present from the migration). */
async function defaultOrgId(): Promise<string> {
  const rows = await queryClient<{ id: string }[]>`
    SELECT id FROM organizations WHERE is_default = true LIMIT 1`;
  return rows[0].id;
}

async function defaultWorkspaceId(): Promise<string> {
  const rows = await queryClient<{ id: string }[]>`
    SELECT id FROM workspaces WHERE is_default = true LIMIT 1`;
  return rows[0].id;
}

async function ownerRoleId(): Promise<string> {
  const rows = await queryClient<{ id: string }[]>`
    SELECT id FROM roles WHERE key = 'owner' AND is_system = true LIMIT 1`;
  return rows[0].id;
}

describe.skipIf(!DB_AVAILABLE)("RBAC tenancy schema after the full migration chain", () => {
  it("seeds exactly one default organization and one default workspace", async () => {
    const orgs = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM organizations WHERE is_default = true`;
    expect(orgs[0].n).toBe(1);

    const workspaces = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM workspaces WHERE is_default = true`;
    expect(workspaces[0].n).toBe(1);
  });

  it("seeds exactly four system roles with the full permission matrix", async () => {
    const roles = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM roles WHERE is_system = true`;
    expect(roles[0].n).toBe(4);

    const counts = await queryClient<{ key: string; n: number }[]>`
      SELECT r.key, count(rp.permission)::int AS n
      FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.is_system = true GROUP BY r.key`;
    const byKey = Object.fromEntries(counts.map((c) => [c.key, c.n]));

    // DERIVED from `permissions.ts`, never re-typed here. The literal
    // `{ owner: 33, admin: 32, member: 23, viewer: 14 }` broke the build the
    // moment migration 0072 granted Member three more permissions — a number in
    // a test that nobody updates in the same commit as the migration. That is
    // also what `permissions.ts` means when its own docblock says the matrix "is
    // the single source of truth shared by the migration seed and the tests, so
    // the matrix is never duplicated as magic strings".
    const expected = Object.fromEntries(
      SYSTEM_ROLE_KEYS.map((key) => [key, SYSTEM_ROLE_PERMISSIONS[key].length]),
    );
    expect(byKey).toEqual(expected);
  });

  it("seeds the exact permission STRINGS that SYSTEM_ROLE_PERMISSIONS declares", async () => {
    // Count alone would let a same-count swap slip through; compare the actual
    // strings so permissions.ts stays the single source of truth for the seed.
    const rows = await queryClient<{ key: string; permission: string }[]>`
      SELECT r.key, rp.permission
      FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.is_system = true`;
    const seeded: Record<string, string[]> = {};
    for (const { key, permission } of rows) (seeded[key] ??= []).push(permission);

    for (const key of SYSTEM_ROLE_KEYS) {
      expect(new Set(seeded[key])).toEqual(new Set(SYSTEM_ROLE_PERMISSIONS[key]));
    }
  });

  it("gives every workspace_id on instances the default workspace (NOT NULL)", async () => {
    const nulls = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM instances WHERE workspace_id IS NULL`;
    expect(nulls[0].n).toBe(0);
  });

  it("leaves is_platform_admin as the only persisted platform-admin standing", async () => {
    // The original assertion — "no user with role IN ('platform_admin',
    // 'superadmin') was left with is_platform_admin = false" — is now
    // discharged by 0075's reconciliation UPDATE, which runs immediately
    // before the DROP. Asserting it again is impossible AND unnecessary: the
    // column it read no longer exists. What is still falsifiable is that the
    // drop happened, so the schema itself is the assertion.
    const column = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users' AND column_name = 'role'`;
    expect(column[0].n).toBe(0);

    // And that the column standing MOVED to survived the chain intact: still
    // there, still boolean, still NOT NULL, so a row can never carry an
    // undecided standing. Deliberately NOT "at least one is_platform_admin =
    // true row exists": no migration seeds a user and the boot seeder does not
    // run in this suite, so CI's freshly migrated database has an empty `users`
    // table and such an assertion would fail there — the very class of
    // DB-only failure this test was rewritten to stop producing.
    const flag = await queryClient<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users' AND column_name = 'is_platform_admin'`;
    expect(flag).toHaveLength(1);
    expect(flag[0].data_type).toBe("boolean");
    expect(flag[0].is_nullable).toBe("NO");

    // Whatever rows the database does hold, none of them lost their standing to
    // an unset flag while `role` was being dropped.
    const undecided = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users WHERE is_platform_admin IS NULL`;
    expect(undecided[0].n).toBe(0);
  });

  it("backfilled exactly one membership + one Owner binding per pre-existing user", async () => {
    const orgId = await defaultOrgId();
    const ownerId = await ownerRoleId();

    const usersWithoutMembership = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM organization_memberships m
        WHERE m.user_id = u.id AND m.organization_id = ${orgId})`;
    expect(usersWithoutMembership[0].n).toBe(0);

    const usersWithoutOwner = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM role_bindings b
        WHERE b.user_id = u.id AND b.role_id = ${ownerId}
          AND b.scope_type = 'organization' AND b.organization_id = ${orgId})`;
    expect(usersWithoutOwner[0].n).toBe(0);

    // Exactly one Owner org-binding each (no duplicates from the backfill).
    const dupes = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT user_id FROM role_bindings
        WHERE role_id = ${ownerId} AND scope_type = 'organization' AND organization_id = ${orgId}
        GROUP BY user_id HAVING count(*) > 1
      ) d`;
    expect(dupes[0].n).toBe(0);
  });

  describe("scope_id integrity trigger", () => {
    afterEach(async () => {
      await queryClient`DELETE FROM users WHERE email LIKE 'itest-rbac-%'`;
    });

    async function makeUser(): Promise<string> {
      const rows = await queryClient<{ id: string }[]>`
        INSERT INTO users (email, name) VALUES (${`itest-rbac-${Date.now()}-${Math.random()}@x.local`}, 'itest')
        RETURNING id`;
      return rows[0].id;
    }

    it("accepts an organization-scope binding where scope_id = organization_id", async () => {
      const orgId = await defaultOrgId();
      const ownerId = await ownerRoleId();
      const userId = await makeUser();
      await expect(
        queryClient`
          INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
          VALUES (${userId}, ${ownerId}, 'organization', ${orgId}, ${orgId})`,
      ).resolves.toBeDefined();
    });

    it("rejects an organization-scope binding where scope_id != organization_id", async () => {
      const orgId = await defaultOrgId();
      const wsId = await defaultWorkspaceId();
      const ownerId = await ownerRoleId();
      const userId = await makeUser();
      await expect(
        queryClient`
          INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
          VALUES (${userId}, ${ownerId}, 'organization', ${wsId}, ${orgId})`,
      ).rejects.toThrow(/scope_id must equal organization_id/);
    });

    it("accepts a workspace-scope binding for a workspace in the org", async () => {
      const orgId = await defaultOrgId();
      const wsId = await defaultWorkspaceId();
      const ownerId = await ownerRoleId();
      const userId = await makeUser();
      await expect(
        queryClient`
          INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
          VALUES (${userId}, ${ownerId}, 'workspace', ${wsId}, ${orgId})`,
      ).resolves.toBeDefined();
    });

    it("rejects a workspace-scope binding for a workspace outside the org", async () => {
      const orgId = await defaultOrgId();
      const ownerId = await ownerRoleId();
      const userId = await makeUser();
      // A random UUID that is not a workspace of this org.
      await expect(
        queryClient`
          INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
          VALUES (${userId}, ${ownerId}, 'workspace', gen_random_uuid(), ${orgId})`,
      ).rejects.toThrow(/workspace belonging to the binding organization/);
    });
  });

  describe("uq_role_bindings_user_role_scope unique constraint", () => {
    afterEach(async () => {
      await queryClient`DELETE FROM users WHERE email LIKE 'itest-rbac-uniq-%'`;
    });

    it("rejects a duplicate (user, role, scope) binding at the DB level", async () => {
      const orgId = await defaultOrgId();
      const ownerId = await ownerRoleId();
      const [{ id: userId }] = await queryClient<{ id: string }[]>`
        INSERT INTO users (email, name) VALUES (${`itest-rbac-uniq-${Date.now()}@x.local`}, 'itest')
        RETURNING id`;

      await queryClient`
        INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
        VALUES (${userId}, ${ownerId}, 'organization', ${orgId}, ${orgId})`;

      // Second identical insert must be rejected by the unique index — the DB,
      // not a select-then-insert guard, is the idempotency mechanism.
      await expect(
        queryClient`
          INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
          VALUES (${userId}, ${ownerId}, 'organization', ${orgId}, ${orgId})`,
      ).rejects.toThrow(/uq_role_bindings_user_role_scope|duplicate key/);
    });
  });
});
