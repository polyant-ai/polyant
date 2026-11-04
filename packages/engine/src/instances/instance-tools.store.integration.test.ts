// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The tool rows an agent holds, against a real database: the manual switches an
 * operator flips, and the recompute that decides which tools the agent gets
 * from the catalog's globals, its enabled skills and those manual switches.
 * Which rows a statement touches is decided by its WHERE clause, and only a
 * real database shows that a change on one agent leaves another agent's rows
 * alone. Self-skips without a database; CI_REQUIRE_DB makes an absent one a
 * failure there.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { applyManualToolChanges, listInstanceToolRows, recomputeInstanceTools } from "./instance-tools.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-instance-tools";

let agentA: InstanceUuid;
let agentB: InstanceUuid;
const toolIds: Record<string, string> = {};

async function plantAgent(slug: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
    RETURNING id`;
  return asInstanceUuid(row.id);
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM tools WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM skills WHERE slug LIKE ${MARKER + "%"}`;
}

/** Assign the agent a skill whose pinned version requires `requiredTools`. */
async function assignSkill(agent: InstanceUuid, name: string, requiredTools: string[], enabled: boolean): Promise<void> {
  const slug = `${MARKER}-${name}`;
  const [{ id: skillId }] = await queryClient<{ id: string }[]>`
    INSERT INTO skills (slug, name) VALUES (${slug}, ${slug}) RETURNING id`;
  const [{ id: versionId }] = await queryClient<{ id: string }[]>`
    INSERT INTO skill_versions (skill_id, version, content, metadata)
    VALUES (${skillId}, '1.0.0', 'body', ${JSON.stringify({ requiredTools })}::jsonb) RETURNING id`;
  await queryClient`
    INSERT INTO instance_skills (instance_id, skill_id, skill_version_id, enabled)
    VALUES (${agent}, ${skillId}, ${versionId}, ${enabled})`;
}

const names = async (id: InstanceUuid) =>
  (await listInstanceToolRows(id)).map((r) => `${r.name}:${r.source}`).sort();

describe.skipIf(!DB_AVAILABLE)("instance tools store (integration)", () => {
  beforeAll(async () => {
    await teardown();
    agentA = await plantAgent(`${MARKER}-a`);
    agentB = await plantAgent(`${MARKER}-b`);
    for (const name of ["one", "two", "three"]) {
      const [row] = await queryClient<{ id: string }[]>`
        INSERT INTO tools (name, description) VALUES (${`${MARKER}-${name}`}, 'test tool') RETURNING id`;
      toolIds[name] = row.id;
    }
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM instance_tools WHERE instance_id IN (${agentA}, ${agentB})`;
  });

  afterAll(teardown);

  it("adds manual rows and removes others in one call, touching only the named agent", async () => {
    await applyManualToolChanges(agentA, [toolIds.one, toolIds.two], []);
    await applyManualToolChanges(agentB, [toolIds.two], []);

    await applyManualToolChanges(agentA, [toolIds.three], [toolIds.two]);

    expect(await names(agentA)).toEqual([`${MARKER}-one:manual`, `${MARKER}-three:manual`]);
    expect(await names(agentB)).toEqual([`${MARKER}-two:manual`]);
  });

  it("leaves a tool the agent already has as it is", async () => {
    await queryClient`
      INSERT INTO instance_tools (instance_id, tool_id, source) VALUES (${agentA}, ${toolIds.one}, 'global')`;
    await applyManualToolChanges(agentA, [toolIds.one], []);
    expect(await names(agentA)).toEqual([`${MARKER}-one:global`]);
  });
});

describe.skipIf(!DB_AVAILABLE)("recomputeInstanceTools (integration)", () => {
  // The catalog's global tools are shared by every agent in the database, so
  // these tests name theirs through `precomputed` instead of flagging a row
  // global for everyone else.
  const globals = () => ({ globalToolIds: [toolIds.global] });

  beforeAll(async () => {
    await teardown();
    agentA = await plantAgent(`${MARKER}-a`);
    agentB = await plantAgent(`${MARKER}-b`);
    for (const name of ["one", "global", "skill", "off"]) {
      const [row] = await queryClient<{ id: string }[]>`
        INSERT INTO tools (name, description) VALUES (${`${MARKER}-${name}`}, 'test tool') RETURNING id`;
      toolIds[name] = row.id;
    }
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM instance_tools WHERE instance_id IN (${agentA}, ${agentB})`;
    await queryClient`DELETE FROM skills WHERE slug LIKE ${MARKER + "%"}`;
  });

  afterAll(teardown);

  it("gives the agent the globals, the tools its enabled skills require and its manual rows", async () => {
    await assignSkill(agentA, "skill-on", [`${MARKER}-skill`], true);
    await assignSkill(agentA, "skill-off", [`${MARKER}-off`], false);
    await applyManualToolChanges(agentA, [toolIds.one], []);

    await recomputeInstanceTools(agentA, undefined, globals());

    expect(await names(agentA)).toEqual([`${MARKER}-global:global`, `${MARKER}-one:manual`, `${MARKER}-skill:skill`]);
    expect(await names(agentB)).toEqual([]);
  });

  it("leaves the same rows, once each, when it runs again", async () => {
    await assignSkill(agentA, "skill-on", [`${MARKER}-skill`], true);
    await recomputeInstanceTools(agentA, undefined, globals());
    const first = await queryClient<{ id: string }[]>`SELECT id FROM instance_tools WHERE instance_id = ${agentA} ORDER BY id`;

    await recomputeInstanceTools(agentA, undefined, globals());

    const second = await queryClient<{ id: string }[]>`SELECT id FROM instance_tools WHERE instance_id = ${agentA} ORDER BY id`;
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it("takes away a skill's tool once the skill is switched off, and keeps the manual rows", async () => {
    await assignSkill(agentA, "skill-on", [`${MARKER}-skill`], true);
    await applyManualToolChanges(agentA, [toolIds.one], []);
    await recomputeInstanceTools(agentA, undefined, globals());

    await queryClient`
      UPDATE instance_skills SET enabled = false
      WHERE instance_id = ${agentA} AND skill_id = (SELECT id FROM skills WHERE slug = ${`${MARKER}-skill-on`})`;
    await recomputeInstanceTools(agentA, undefined, globals());

    expect(await names(agentA)).toEqual([`${MARKER}-global:global`, `${MARKER}-one:manual`]);
  });

  it("removes every row when nothing is wanted any more", async () => {
    await queryClient`
      INSERT INTO instance_tools (instance_id, tool_id, source)
      VALUES (${agentA}, ${toolIds.global}, 'global'), (${agentA}, ${toolIds.skill}, 'skill')`;

    await recomputeInstanceTools(agentA, undefined, { globalToolIds: [] });

    expect(await names(agentA)).toEqual([]);
  });

  it("reads the catalog's globals and writes on the caller's transaction, so a rollback undoes it", async () => {
    await applyManualToolChanges(agentA, [toolIds.one], []);
    const rolledBack = new Error("roll back");

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE tools SET is_global = true WHERE id = ${toolIds.global}`);
        await recomputeInstanceTools(agentA, tx);
        const inside = await tx.execute<{ name: string }>(sql`
          SELECT t.name FROM instance_tools it JOIN tools t ON t.id = it.tool_id
          WHERE it.instance_id = ${agentA} AND t.name LIKE ${MARKER + "%"} ORDER BY t.name`);
        expect([...inside].map((r) => r.name)).toEqual([`${MARKER}-global`, `${MARKER}-one`]);
        throw rolledBack;
      }),
    ).rejects.toBe(rolledBack);

    expect(await names(agentA)).toEqual([`${MARKER}-one:manual`]);
  });
});
