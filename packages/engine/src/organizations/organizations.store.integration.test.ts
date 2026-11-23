// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `ensureExistingPlatformAdminOwner` against a real Postgres: the boot path that
 * makes the seeded platform admin an Owner of the default organization. It must
 * refuse an account that is not already a platform admin (configuration never
 * elevates an address), replace only organization-scoped roles, leave workspace
 * roles alone, and drop the cached bindings it changed. Self-skips when no
 * migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { bindingCache, bindingCacheKey } from "../authz/authz.caches.js";
import { ensureExistingPlatformAdminOwner } from "./organizations.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-org-bootstrap";
const ADMIN_EMAIL = `${MARKER}-boss@example.test`;
const PLAIN_EMAIL = `${MARKER}-plain@example.test`;

let defaultOrgId: string;
let defaultWorkspaceId: string;
let adminId: string;
let plainId: string;
const role: Record<string, string> = {};

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM role_bindings WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`;
}

async function bindingsOf(userId: string) {
  const rows = await queryClient<{ binding: string }[]>`
    SELECT rb.scope_type || ':' || r.key AS binding FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
    WHERE rb.user_id = ${userId} AND rb.organization_id = ${defaultOrgId} ORDER BY 1`;
  return rows.map((r) => r.binding);
}

describe.skipIf(!DB_AVAILABLE)("bootstrap owner of the default organization (integration)", () => {
  beforeAll(async () => {
    await teardown();
    [{ id: defaultOrgId }] = await queryClient<{ id: string }[]>`SELECT id FROM organizations WHERE is_default = true`;
    [{ id: defaultWorkspaceId }] = await queryClient<{ id: string }[]>`
      SELECT id FROM workspaces WHERE organization_id = ${defaultOrgId} ORDER BY is_default DESC LIMIT 1`;
    [{ id: adminId }] = await queryClient<{ id: string }[]>`
      INSERT INTO users (email, name, is_platform_admin) VALUES (${ADMIN_EMAIL}, 'Boss', true) RETURNING id`;
    [{ id: plainId }] = await queryClient<{ id: string }[]>`
      INSERT INTO users (email, name, is_platform_admin) VALUES (${PLAIN_EMAIL}, 'Plain', false) RETURNING id`;
    for (const r of await queryClient<{ id: string; key: string }[]>`SELECT id, key FROM roles WHERE is_system = true`) {
      role[r.key] = r.id;
    }
  });

  afterAll(teardown);

  it("makes the platform admin the owner, found by email in any case, replacing org roles and keeping workspace ones", async () => {
    await queryClient`
      INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id) VALUES
        (${adminId}, ${role.admin!}, 'organization', ${defaultOrgId}, ${defaultOrgId}),
        (${adminId}, ${role.member!}, 'organization', ${defaultOrgId}, ${defaultOrgId}),
        (${adminId}, ${role.admin!}, 'workspace', ${defaultWorkspaceId}, ${defaultOrgId})`;
    bindingCache.set(bindingCacheKey(adminId, defaultOrgId), []);

    // It answers with the organization it made the admin owner of.
    await expect(ensureExistingPlatformAdminOwner(`  ${ADMIN_EMAIL.toUpperCase()} `)).resolves.toBe(defaultOrgId);

    expect(await bindingsOf(adminId)).toEqual(["organization:owner", "workspace:admin"]);
    const [{ n }] = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id = ${defaultOrgId} AND user_id = ${adminId}`;
    expect(n).toBe(1);
    expect(bindingCache.has(bindingCacheKey(adminId, defaultOrgId))).toBe(false);
  });

  it("is a no-op the second time", async () => {
    await ensureExistingPlatformAdminOwner(ADMIN_EMAIL);

    expect(await bindingsOf(adminId)).toEqual(["organization:owner", "workspace:admin"]);
  });

  it("refuses an account that is not already a platform admin, granting nothing", async () => {
    await expect(ensureExistingPlatformAdminOwner(PLAIN_EMAIL)).resolves.toBeNull();

    expect(await bindingsOf(plainId)).toEqual([]);
  });
});
