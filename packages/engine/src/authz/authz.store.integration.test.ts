// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for `authz.store` — the four queries that decide who gets in.
 *
 * `PermissionGuard` sits at 94% coverage, but every one of its tests MOCKS these
 * four functions, so the SQL underneath was at 4% of lines and 0% of branches: a
 * renamed column or a wrong join here passed typecheck, passed 2 900 unit tests,
 * and would have shipped.
 *
 * These need a real database — the defects worth catching are join shape and
 * predicate scope, and a mock cannot have either wrong. Self-skips without one;
 * CI_REQUIRE_DB makes an absent database a failure there.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryClient } from "../database/client.js";
import {
  readPlatformAdminFlag,
  readAgentScope,
  readWorkspaceId,
  readUserBindings,
  invalidateWorkspaceIdCache,
} from "./authz.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-authz-store";

interface Seed {
  orgA: string;
  orgB: string;
  wsA: string;
  userId: string;
  strangerId: string;
  roleId: string;
}

let seed: Seed;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM role_bindings WHERE scope_id IN (SELECT id FROM organizations WHERE slug LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM organization_memberships WHERE organization_id IN (SELECT id FROM organizations WHERE slug LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`;
  invalidateWorkspaceIdCache();
}

async function setup(): Promise<Seed> {
  const [{ id: orgA }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER + "-a"}, 'A', false) RETURNING id`;
  const [{ id: orgB }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER + "-b"}, 'B', false) RETURNING id`;

  // SAME workspace slug in both orgs — the case `readWorkspaceId` exists for.
  const [{ id: wsA }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default)
    VALUES (${orgA}, ${MARKER + "-shared"}, 'ws A', false) RETURNING id`;
  await queryClient`
    INSERT INTO workspaces (organization_id, slug, name, is_default)
    VALUES (${orgB}, ${MARKER + "-shared"}, 'ws B', false)`;

  await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${MARKER + "-agent"}, 'agent', ${wsA})`;

  const [{ id: userId }] = await queryClient<{ id: string }[]>`
    INSERT INTO users (email, name, is_platform_admin) VALUES (${MARKER + "-user@example.test"}, 'U', false) RETURNING id`;
  const [{ id: strangerId }] = await queryClient<{ id: string }[]>`
    INSERT INTO users (email, name, is_platform_admin) VALUES (${MARKER + "-admin@example.test"}, 'PA', true) RETURNING id`;

  const [{ id: roleId }] = await queryClient<{ id: string }[]>`
    SELECT id FROM roles WHERE key = 'viewer' AND is_system = true AND organization_id IS NULL LIMIT 1`;

  return { orgA, orgB, wsA, userId, strangerId, roleId };
}

describe.skipIf(!DB_AVAILABLE)("authz.store (integration)", () => {
  beforeAll(async () => {
    await teardown();
    seed = await setup();
  });

  afterAll(teardown);

  describe("readPlatformAdminFlag", () => {
    it("should_read_the_live_flag_and_default_false_for_an_unknown_user", async () => {
      expect(await readPlatformAdminFlag(seed.strangerId)).toBe(true);
      expect(await readPlatformAdminFlag(seed.userId)).toBe(false);
      expect(await readPlatformAdminFlag("00000000-0000-0000-0000-000000000000")).toBe(false);
    });
  });

  describe("readAgentScope", () => {
    it("should_resolve_an_agent_to_its_workspace_and_organization", async () => {
      const scope = await readAgentScope(MARKER + "-agent");

      expect(scope).toEqual({
        agentId: expect.any(String),
        workspaceId: seed.wsA,
        organizationId: seed.orgA,
      });
    });

    it("should_return_null_for_an_unknown_slug", async () => {
      expect(await readAgentScope(MARKER + "-nope")).toBeNull();
    });
  });

  describe("readWorkspaceId", () => {
    /*
      The property the docblock claims and nothing tested: a workspace slug is
      NOT globally unique, so resolving one without its organization would let a
      URL for one tenant validate against another tenant's workspace. Both orgs
      here own a workspace with the same slug.
    */
    it("should_resolve_a_shared_slug_to_the_addressed_organization_only", async () => {
      const a = await readWorkspaceId(seed.orgA, MARKER + "-shared");
      const b = await readWorkspaceId(seed.orgB, MARKER + "-shared");

      expect(a).toBe(seed.wsA);
      expect(b).not.toBe(seed.wsA);
      expect(b).not.toBeNull();
    });

    it("should_return_null_when_the_slug_names_no_workspace_in_that_org", async () => {
      expect(await readWorkspaceId(seed.orgA, MARKER + "-absent")).toBeNull();
    });
  });

  describe("readUserBindings", () => {
    it("should_return_no_bindings_for_a_user_who_holds_none", async () => {
      expect(await readUserBindings(seed.userId, seed.orgA)).toEqual([]);
    });

    it("should_expand_a_binding_into_its_role_permission_set", async () => {
      await queryClient`
        INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
        VALUES (${seed.userId}, ${seed.roleId}, 'organization', ${seed.orgA}, ${seed.orgA})`;

      const bindings = await readUserBindings(seed.userId, seed.orgA);

      expect(bindings).toHaveLength(1);
      expect(bindings[0].scopeType).toBe("organization");
      expect(bindings[0].scopeId).toBe(seed.orgA);
      expect(bindings[0].permissions.size).toBeGreaterThan(0);
    });

    it("should_not_return_a_binding_from_another_organization", async () => {
      expect(await readUserBindings(seed.userId, seed.orgB)).toEqual([]);
    });

    /*
      PINS CURRENT BEHAVIOUR, and it is not the behaviour CLAUDE.md describes.

      The file says "a binding without a membership is a member who resolves no
      scope and is denied everywhere". That holds for routes whose scope comes
      from the JWT `orgId` (which is stamped from a membership) — but this query
      joins no membership at all, so on an AGENT-addressed route, where the org
      is derived from the agent, the surviving binding still grants.

      Reachable only if the pair ever diverges. Every writer keeps them in sync
      today, which is exactly why nothing tested it. Asserted here so that
      whoever changes the invariant sees this test go red instead of discovering
      it in production.
    */
    it("should_still_grant_on_a_binding_left_behind_by_a_removed_member", async () => {
      await queryClient`DELETE FROM organization_memberships WHERE user_id = ${seed.userId} AND organization_id = ${seed.orgA}`;

      const bindings = await readUserBindings(seed.userId, seed.orgA);

      expect(bindings).toHaveLength(1);
    });
  });
});
