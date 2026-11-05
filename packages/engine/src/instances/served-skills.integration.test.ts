// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A skill an agent has switched off is not served: its row stays so turning it
 * back on restores the configuration, and everything that hands out a skill's
 * content, script or credentials asks `filterServedSkillSlugs`.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceUuid } from "./identifiers.js";
import { filterServedSkillSlugs } from "./instance-skills.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = `itest-served-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function skill(slug: string): Promise<{ skillId: string; versionId: string }> {
  const [{ id: skillId }] = await queryClient<{ id: string }[]>`
    INSERT INTO skills (slug, name) VALUES (${slug}, ${slug}) RETURNING id`;
  const [{ id: versionId }] = await queryClient<{ id: string }[]>`
    INSERT INTO skill_versions (skill_id, version, content, metadata) VALUES (${skillId}, '1.0.0', 'body', '{}'::jsonb) RETURNING id`;
  return { skillId, versionId };
}

describe.skipIf(!DB_AVAILABLE)("filterServedSkillSlugs (integration)", () => {
  let agentId = "";
  let otherAgentId = "";
  const on = `${MARKER}-on`;
  const off = `${MARKER}-off`;
  const elsewhere = `${MARKER}-elsewhere`;

  beforeAll(async () => {
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, ${MARKER}, false) RETURNING id`;
    const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, ${MARKER}, false) RETURNING id`;
    [{ id: agentId }] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id) VALUES (${`${MARKER}-agent`}, 'a', ${workspaceId}) RETURNING id`;
    [{ id: otherAgentId }] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id) VALUES (${`${MARKER}-other`}, 'b', ${workspaceId}) RETURNING id`;
    for (const [slug, instanceId, enabled] of [[on, agentId, true], [off, agentId, false], [elsewhere, otherAgentId, true]] as const) {
      const { skillId, versionId } = await skill(slug);
      await queryClient`
        INSERT INTO instance_skills (instance_id, skill_id, skill_version_id, enabled)
        VALUES (${instanceId}, ${skillId}, ${versionId}, ${enabled})`;
    }
  });

  afterAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM skills WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM workspaces WHERE slug = ${MARKER}`;
    await queryClient`DELETE FROM organizations WHERE slug = ${MARKER}`;
  });

  it("serves only the agent's enabled skills", async () => {
    const served = await filterServedSkillSlugs(asInstanceUuid(agentId), [on, off, elsewhere, `${MARKER}-missing`]);

    expect([...served]).toEqual([on]);
  });
});
