// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for `createInstanceWithDefaults` — the create path itself.
 *
 * v1.1.0 shipped a POST /api/instances that 500s on every call, and 2 969 unit
 * tests stayed green through it: they mock the database, so they can pin WHICH
 * arguments the seed helpers receive and never WHERE their writes land. The
 * defect was exactly that — the caller's `tx` reached the helper, the helper
 * read on it and then wrote on the module `db`, a second pooled connection that
 * cannot see the uncommitted `instances` row, and the insert died on the foreign
 * key. Only a real database can have that wrong.
 *
 * Self-skips without one; CI_REQUIRE_DB makes an absent database a failure there.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { queryClient } from "../database/client.js";

/*
  The last of the four seeds, wrapped so one test can make it throw. Everything
  before it - the `instances` row, the prompt sections, the tool rows - has by
  then really been written on the transaction, which is the state a rollback has
  to undo. Nothing else in this file is mocked: the wrapper delegates to the real
  implementation unless a test arms it.
*/
let failTheSkillSeed = false;
vi.mock("./instance-skills.store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./instance-skills.store.js")>();
  return {
    ...actual,
    seedInstanceSkills: async (...args: Parameters<typeof actual.seedInstanceSkills>) => {
      if (failTheSkillSeed) throw new Error("seed failed after the agent row was written");
      return actual.seedInstanceSkills(...args);
    },
  };
});

import { createInstanceWithDefaults } from "./store.js";
import { asInstanceSlug } from "./identifiers.js";
import { DEFAULT_TOOL_NAMES, DEFAULT_PROMPTS } from "./defaults.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-create-instance";

let orgId: string;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM tools WHERE description = ${MARKER}`;
}

async function setup(): Promise<void> {
  const [org] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'create-path org', false)
    RETURNING id`;
  orgId = org.id;
  await queryClient`
    INSERT INTO workspaces (organization_id, slug, name, is_default)
    VALUES (${orgId}, ${MARKER + "-ws"}, 'create-path ws', false)`;

  // The seed is a no-op on an empty catalog, which would make this test pass
  // against the very bug it exists for. The tools are discovered at boot, so on
  // a bare migrated database they have to be put there.
  for (const name of DEFAULT_TOOL_NAMES) {
    await queryClient`
      INSERT INTO tools (name, description, category) VALUES (${name}, ${MARKER}, 'general')
      ON CONFLICT (name) DO NOTHING`;
  }
}

describe.skipIf(!DB_AVAILABLE)("createInstanceWithDefaults (integration)", () => {
  beforeAll(async () => {
    await teardown();
    await setup();
  });

  afterAll(teardown);

  it("should_create_the_agent_with_its_tools_and_prompts_in_one_transaction", async () => {
    const slug = asInstanceSlug(MARKER + "-agent");

    const instance = await createInstanceWithDefaults({
      slug,
      name: "Create path",
      orgId,
      workspaceSlug: MARKER + "-ws",
    });

    expect(instance.slug).toBe(slug);

    const toolRows = await queryClient<{ name: string }[]>`
      SELECT t.name FROM instance_tools it
      JOIN tools t ON t.id = it.tool_id
      WHERE it.instance_id = ${instance.id}`;
    expect(toolRows.map((r) => r.name).sort()).toEqual([...DEFAULT_TOOL_NAMES].sort());

    const promptRows = await queryClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM instance_prompts WHERE instance_id = ${instance.id}`;
    expect(Number(promptRows[0].count)).toBe(DEFAULT_PROMPTS.length);
  });

  it("should_leave_no_agent_behind_when_a_later_seed_fails", async () => {
    const slug = asInstanceSlug(MARKER + "-rollback");

    failTheSkillSeed = true;
    try {
      await expect(
        createInstanceWithDefaults({
          slug,
          name: "Rolled back",
          orgId,
          workspaceSlug: MARKER + "-ws",
        }),
      ).rejects.toThrow(/seed failed/);
    } finally {
      failTheSkillSeed = false;
    }

    // The agent row, its prompts and its tools were written before the failure.
    // Outside a transaction they would still be here, and the slug would be
    // taken by an agent that does not work and cannot be recreated.
    const rows = await queryClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM instances WHERE slug = ${slug}`;
    expect(Number(rows[0].count)).toBe(0);

    const orphans = await queryClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM instance_prompts p
      WHERE NOT EXISTS (SELECT 1 FROM instances i WHERE i.id = p.instance_id)`;
    expect(Number(orphans[0].count)).toBe(0);
  });

  it("should_refuse_a_slug_that_is_already_taken", async () => {
    await expect(
      createInstanceWithDefaults({
        slug: asInstanceSlug(MARKER + "-agent"),
        name: "Duplicate",
        orgId,
        workspaceSlug: MARKER + "-ws",
      }),
    ).rejects.toThrow();
  });
});
