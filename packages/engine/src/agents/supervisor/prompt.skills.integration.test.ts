// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The skills list in an agent's system prompt, against a real Postgres: the
 * agent's own skills that are switched on and not archived, in slug order so
 * the cached prompt prefix never reorders. Archiving a skill through the skills
 * service takes it out of the list and keeps its row. Self-skips when no
 * migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../../database/test-db.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "../../instances/identifiers.js";
import { invalidatePromptsCache, seedInstancePrompts } from "../../instances/prompts.store.js";
import { db, queryClient } from "../../database/client.js";
import { SkillsService } from "../../skills/skills.service.js";
import { buildSupervisorSystemPrompt } from "./prompt.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-prompt-skills";
const SLUG = asInstanceSlug(`${MARKER}-agent`);
let agent: InstanceUuid;
let other: InstanceUuid;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM skills WHERE slug LIKE ${MARKER + "%"}`;
}

async function plant(slug: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)) RETURNING id`;
  return asInstanceUuid(row!.id);
}

async function assign(agentId: string, name: string, enabled: boolean): Promise<void> {
  const slug = `${MARKER}-${name}`;
  const [{ id: skillId }] = await queryClient<{ id: string }[]>`
    INSERT INTO skills (slug, name, description) VALUES (${slug}, ${slug}, ${`does ${name}`}) RETURNING id`;
  const [{ id: versionId }] = await queryClient<{ id: string }[]>`
    INSERT INTO skill_versions (skill_id, version, content, metadata) VALUES (${skillId}, '1.0.0', 'body', '{}'::jsonb) RETURNING id`;
  await queryClient`UPDATE skills SET current_version_id = ${versionId} WHERE id = ${skillId}`;
  await queryClient`
    INSERT INTO instance_skills (instance_id, skill_id, skill_version_id, enabled)
    VALUES (${agentId}, ${skillId}, ${versionId}, ${enabled})`;
}

/** The skill names the prompt lists, in the order it lists them. */
async function listedSkills(): Promise<string[]> {
  invalidatePromptsCache(agent);
  const { system } = await buildSupervisorSystemPrompt({ instanceId: agent, instanceSlug: SLUG });
  return [...system.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]!);
}

describe.skipIf(!DB_AVAILABLE)("skills in the system prompt (integration)", () => {
  beforeAll(async () => {
    await teardown();
    agent = await plant(SLUG);
    // The skills reach the prompt through the seeded `{{skillsList}}` section.
    await seedInstancePrompts(agent, db);
    other = await plant(`${MARKER}-other`);
    await assign(agent, "zulu", true);
    await assign(agent, "alpha", true);
    await assign(agent, "mike-off", false);
    await assign(other, "theirs", true);
  });

  afterAll(teardown);

  it("lists the agent's switched-on skills in slug order, and no one else's", async () => {
    expect(await listedSkills()).toEqual([`${MARKER}-alpha`, `${MARKER}-zulu`]);
  });

  it("drops a skill once it is archived, keeping its row", async () => {
    expect(await new SkillsService().deleteSkill(`${MARKER}-zulu`)).toBe(true);

    expect(await listedSkills()).toEqual([`${MARKER}-alpha`]);
    const [row] = await queryClient<{ status: string }[]>`SELECT status FROM skills WHERE slug = ${`${MARKER}-zulu`}`;
    expect(row!.status).toBe("archived");
    expect(await new SkillsService().deleteSkill(`${MARKER}-never-existed`)).toBe(false);
  });
});
