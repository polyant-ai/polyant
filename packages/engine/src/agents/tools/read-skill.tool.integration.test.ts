// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The readSkill tool against a real Postgres: it returns the pinned version of a
 * skill the agent has switched on, nothing for one that is off or belongs to
 * another agent, and the skill's variables with every sensitive value replaced
 * by a placeholder. Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../../database/client.js";
import { resolveDatabaseAvailability } from "../../database/test-db.js";
import { asInstanceUuid } from "../../instances/identifiers.js";
import { setSkillEnv } from "../../instances/skill-env.store.js";
import { createMockAudit } from "../../test-utils.js";
import readSkillTool from "./read-skill.tool.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-read-skill";
const AGENT = `${MARKER}-agent`;
const OTHER = `${MARKER}-other`;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM skills WHERE slug LIKE ${MARKER + "%"}`;
}

async function plantAgent(slug: string): Promise<string> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)) RETURNING id`;
  return row!.id;
}

/** A skill with two versions; the agent is pinned to `pinned`. */
async function assign(agentId: string, slug: string, pinned: "1.0.0" | "2.0.0", enabled: boolean): Promise<void> {
  const [{ id: skillId }] = await queryClient<{ id: string }[]>`
    INSERT INTO skills (slug, name) VALUES (${slug}, ${slug})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  const versions = await queryClient<{ id: string; version: string }[]>`
    INSERT INTO skill_versions (skill_id, version, content, metadata)
    VALUES (${skillId}, '1.0.0', ${`# ${slug} v1`}, '{}'::jsonb), (${skillId}, '2.0.0', ${`# ${slug} v2`}, '{}'::jsonb)
    ON CONFLICT DO NOTHING RETURNING id, version`;
  const pinnedId = versions.length
    ? versions.find((v) => v.version === pinned)!.id
    : (await queryClient<{ id: string }[]>`SELECT id FROM skill_versions WHERE skill_id = ${skillId} AND version = ${pinned}`)[0]!.id;
  await queryClient`
    INSERT INTO instance_skills (instance_id, skill_id, skill_version_id, enabled)
    VALUES (${agentId}, ${skillId}, ${pinnedId}, ${enabled})`;
}

function read(agentSlug: string, name: string) {
  return readSkillTool.execute({ name }, { instanceId: agentSlug, secrets: {}, audit: createMockAudit() } as never) as Promise<
    Record<string, unknown>
  >;
}

describe.skipIf(!DB_AVAILABLE)("readSkill tool (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const agentId = await plantAgent(AGENT);
    const otherId = await plantAgent(OTHER);
    await assign(agentId, `${MARKER}-booking`, "1.0.0", true);
    await assign(agentId, `${MARKER}-off`, "2.0.0", false);
    await assign(otherId, `${MARKER}-theirs`, "2.0.0", true);
    await setSkillEnv({ instanceId: asInstanceUuid(agentId), skillSlug: `${MARKER}-booking`, key: "REGION", value: "eu-west-1", sensitive: false });
    await setSkillEnv({ instanceId: asInstanceUuid(agentId), skillSlug: `${MARKER}-booking`, key: "CRM_TOKEN", value: "sk-live-a91f", sensitive: true });
  });

  afterAll(teardown);

  it("returns the version the agent is pinned to, with its plain variables inline and its sensitive ones as placeholders", async () => {
    const result = await read(AGENT, `${MARKER}-booking`);

    expect(result).toMatchObject({ found: true, name: `${MARKER}-booking`, version: "1.0.0" });
    const content = result.content as string;
    expect(content).toContain(`# ${MARKER}-booking v1`);
    expect(content).toContain('<var name="REGION">eu-west-1</var>');
    expect(content).toContain(`<var name="CRM_TOKEN" value="{{skill_env.${MARKER}-booking.CRM_TOKEN}}" sensitive />`);
    expect(content).not.toContain("sk-live-a91f");
  });

  it("adds no variables block to a skill without variables", async () => {
    await queryClient`UPDATE instance_skills SET enabled = true WHERE instance_id = (SELECT id FROM instances WHERE slug = ${AGENT})
      AND skill_id = (SELECT id FROM skills WHERE slug = ${`${MARKER}-off`})`;
    try {
      const result = await read(AGENT, `${MARKER}-off`);
      expect(result).toMatchObject({ found: true, version: "2.0.0" });
      expect(result.content).not.toContain("<skill_env>");
    } finally {
      await queryClient`UPDATE instance_skills SET enabled = false WHERE instance_id = (SELECT id FROM instances WHERE slug = ${AGENT})
        AND skill_id = (SELECT id FROM skills WHERE slug = ${`${MARKER}-off`})`;
    }
  });

  it("finds nothing for a skill switched off, another agent's skill, an unknown skill or an unknown agent", async () => {
    expect(await read(AGENT, `${MARKER}-off`)).toEqual({ found: false });
    expect(await read(AGENT, `${MARKER}-theirs`)).toEqual({ found: false });
    expect(await read(AGENT, `${MARKER}-nonexistent`)).toEqual({ found: false });
    expect(await read(`${MARKER}-missing`, `${MARKER}-booking`)).toEqual({ found: false, error: "Instance not found" });
  });
});
