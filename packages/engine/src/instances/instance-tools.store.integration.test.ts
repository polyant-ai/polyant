// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The manual tool switches an operator flips, against a real database. Which
 * rows an add or a remove touches is decided by the WHERE clause, and only a
 * real database shows that a remove on one agent leaves another agent's rows
 * alone. Self-skips without a database; CI_REQUIRE_DB makes an absent one a
 * failure there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { applyManualToolChanges, listInstanceToolRows } from "./instance-tools.store.js";

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
