// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for `listAgentWorkspaceSlugs`, the lookup behind
 * `GET /api/activity-stream/live`.
 *
 * The query joins `instances` to `workspaces`, and both tables have a `slug`
 * column. The tenant predicate used to name the bare `slug`, so Postgres
 * rejected the statement as ambiguous and the live stream answered 500 for every
 * caller. The unit test mocks the database and cannot see that; only a real
 * database can.
 *
 * Self-skips without one; CI_REQUIRE_DB makes an absent database a failure there.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryClient } from "../database/client.js";
import { listAgentWorkspaceSlugs } from "./store.js";
import { orgScope } from "../authz/scope-filter.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-agent-ws-slugs";

let orgId: string;
let emptyOrgId: string;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("listAgentWorkspaceSlugs (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [org] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'slugs org', false)
      RETURNING id`;
    orgId = org.id;
    const [empty] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER + "-empty"}, 'empty org', false)
      RETURNING id`;
    emptyOrgId = empty.id;
    const [ws] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default)
      VALUES (${orgId}, ${MARKER + "-ws"}, 'slugs ws', false) RETURNING id`;
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${MARKER + "-agent"}, 'slugs agent', ${ws.id})`;
  });

  afterAll(teardown);

  it("should_map_each_agent_of_the_organization_to_its_workspace_slug", async () => {
    const map = await listAgentWorkspaceSlugs(orgScope(orgId));
    expect(map.get(MARKER + "-agent")).toBe(MARKER + "-ws");
  });

  it("should_return_an_empty_map_for_an_organization_without_agents", async () => {
    const map = await listAgentWorkspaceSlugs(orgScope(emptyOrgId));
    expect(map.size).toBe(0);
  });
});
