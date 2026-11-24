// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Organization membership writes against a real Postgres: setting a member's
 * role leaves one membership and one organization role, removing a member
 * removes every binding they hold in that organization and nothing elsewhere.
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { deleteOrganizationMember, upsertOrganizationMemberRole } from "./members.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-members-store";

let orgId: string;
let otherOrgId: string;
let workspaceId: string;
let userId: string;
const role: Record<string, string> = {};

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM role_bindings WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

async function createOrg(slug: string): Promise<string> {
  const [{ id }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${slug}, 'm', false) RETURNING id`;
  return id;
}

async function holdings(organizationId: string) {
  const memberships = await queryClient<{ n: number }[]>`
    SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id = ${organizationId} AND user_id = ${userId}`;
  const bindings = await queryClient<{ key: string; scope_type: string }[]>`
    SELECT r.key, rb.scope_type FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
    WHERE rb.organization_id = ${organizationId} AND rb.user_id = ${userId} ORDER BY rb.scope_type, r.key`;
  return { memberships: memberships[0]!.n, bindings: bindings.map((b) => `${b.scope_type}:${b.key}`) };
}

describe.skipIf(!DB_AVAILABLE)("organization member writes (integration)", () => {
  beforeAll(async () => {
    await teardown();
    orgId = await createOrg(MARKER);
    otherOrgId = await createOrg(`${MARKER}-other`);
    const [ws] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, 'm', false) RETURNING id`;
    workspaceId = ws!.id;
    const [user] = await queryClient<{ id: string }[]>`
      INSERT INTO users (email, name, is_platform_admin) VALUES (${MARKER + "@example.test"}, 'M', false) RETURNING id`;
    userId = user!.id;
    for (const r of await queryClient<{ id: string; key: string }[]>`SELECT id, key FROM roles WHERE is_system = true`) {
      role[r.key] = r.id;
    }
  });

  afterAll(teardown);

  it("adds a member with one organization role, and a later role replaces it", async () => {
    await upsertOrganizationMemberRole({ organizationId: orgId, userId, roleId: role.member! });
    expect(await holdings(orgId)).toEqual({ memberships: 1, bindings: ["organization:member"] });

    await upsertOrganizationMemberRole({ organizationId: orgId, userId, roleId: role.admin! });
    expect(await holdings(orgId)).toEqual({ memberships: 1, bindings: ["organization:admin"] });
  });

  it("keeps a member's workspace role when their organization role changes", async () => {
    await queryClient`
      INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
      VALUES (${userId}, ${role.viewer!}, 'workspace', ${workspaceId}, ${orgId})`;

    await upsertOrganizationMemberRole({ organizationId: orgId, userId, roleId: role.member! });

    expect((await holdings(orgId)).bindings).toEqual(["organization:member", "workspace:viewer"]);
  });

  it("removes every binding and the membership in that organization only", async () => {
    await upsertOrganizationMemberRole({ organizationId: otherOrgId, userId, roleId: role.member! });

    await deleteOrganizationMember(orgId, userId);

    expect(await holdings(orgId)).toEqual({ memberships: 0, bindings: [] });
    expect(await holdings(otherOrgId)).toEqual({ memberships: 1, bindings: ["organization:member"] });
  });
});
