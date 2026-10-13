// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Skill environment variables against a real database.
 *
 * Two agents can install the same skill and configure the same key with their
 * own credential. Which agent's value a read returns, and which rows a delete
 * removes, is decided by the WHERE clause; a mocked query builder resolves any
 * chain to the rows it was given, so it cannot catch a lost predicate. Sensitive
 * values must also be ciphertext at rest. Self-skips without a database;
 * CI_REQUIRE_DB makes an absent one a failure there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import {
  deleteSkillEnv,
  getSkillEnv,
  getSkillEnvEntries,
  hasAllRequiredEnv,
  hasAllRequiredEnvBatch,
  setSkillEnv,
} from "./skill-env.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-skill-env";
const SLUG_A = asInstanceSlug(`${MARKER}-a`);
const SLUG_B = asInstanceSlug(`${MARKER}-b`);
const SKILL = "weather";

let agentA: InstanceUuid;
let agentB: InstanceUuid;

async function plantAgent(slug: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
    RETURNING id`;
  return asInstanceUuid(row.id);
}

async function teardown(): Promise<void> {
  // Env rows go with their agent (ON DELETE CASCADE).
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("skill env store (integration)", () => {
  beforeAll(async () => {
    await teardown();
    agentA = await plantAgent(SLUG_A);
    agentB = await plantAgent(SLUG_B);
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM instance_skill_env WHERE instance_id IN (${agentA}, ${agentB})`;
  });

  afterAll(teardown);

  it("gives each agent its own value for the same skill and key", async () => {
    await setSkillEnv({ instanceId: agentA, skillSlug: SKILL, key: "API_KEY", value: "key-a", sensitive: true });
    await setSkillEnv({ instanceId: agentB, skillSlug: SKILL, key: "API_KEY", value: "key-b", sensitive: true });
    await setSkillEnv({ instanceId: agentA, skillSlug: "other", key: "API_KEY", value: "other-a", sensitive: false });

    expect(await getSkillEnv(SLUG_A, SKILL)).toEqual({ API_KEY: "key-a" });
    expect(await getSkillEnv(SLUG_B, SKILL)).toEqual({ API_KEY: "key-b" });
    expect(await getSkillEnvEntries(SLUG_B, SKILL)).toEqual([{ key: "API_KEY", value: "key-b", sensitive: true }]);
  });

  it("keeps a sensitive value encrypted at rest and a public one readable", async () => {
    await setSkillEnv({ instanceId: agentA, skillSlug: SKILL, key: "API_KEY", value: "secret-marker", sensitive: true });
    await setSkillEnv({ instanceId: agentA, skillSlug: SKILL, key: "UNITS", value: "metric", sensitive: false });

    const rows = await queryClient<{ key: string; value: string; encrypted: boolean }[]>`
      SELECT key, value, encrypted FROM instance_skill_env WHERE instance_id = ${agentA} ORDER BY key`;
    expect(rows[0]).toMatchObject({ key: "API_KEY", encrypted: true });
    expect(rows[0].value).not.toContain("secret-marker");
    expect(rows[1]).toEqual({ key: "UNITS", value: "metric", encrypted: false });
    expect(await getSkillEnv(SLUG_A, SKILL)).toEqual({ API_KEY: "secret-marker", UNITS: "metric" });
  });

  it("deletes one key of one skill of one agent", async () => {
    await setSkillEnv({ instanceId: agentA, skillSlug: SKILL, key: "API_KEY", value: "a", sensitive: false });
    await setSkillEnv({ instanceId: agentA, skillSlug: SKILL, key: "UNITS", value: "metric", sensitive: false });
    await setSkillEnv({ instanceId: agentA, skillSlug: "other", key: "API_KEY", value: "o", sensitive: false });
    await setSkillEnv({ instanceId: agentB, skillSlug: SKILL, key: "API_KEY", value: "b", sensitive: false });

    await deleteSkillEnv(agentA, SKILL, "API_KEY");

    expect(await getSkillEnv(SLUG_A, SKILL)).toEqual({ UNITS: "metric" });
    expect(await getSkillEnv(SLUG_A, "other")).toEqual({ API_KEY: "o" });
    expect(await getSkillEnv(SLUG_B, SKILL)).toEqual({ API_KEY: "b" });
  });

  it("counts a required key as configured only when this agent configured it", async () => {
    await setSkillEnv({ instanceId: agentB, skillSlug: SKILL, key: "API_KEY", value: "b", sensitive: true });

    expect(await hasAllRequiredEnv(SLUG_A, SKILL, ["API_KEY"])).toBe(false);
    expect(await hasAllRequiredEnv(SLUG_B, SKILL, ["API_KEY"])).toBe(true);
    expect(await hasAllRequiredEnvBatch(SLUG_A, [{ skillSlug: SKILL, keys: ["API_KEY"] }])).toEqual(
      new Map([[SKILL, false]]),
    );
    expect(await hasAllRequiredEnvBatch(SLUG_B, [{ skillSlug: SKILL, keys: ["API_KEY"] }])).toEqual(
      new Map([[SKILL, true]]),
    );
  });

  it("returns nothing for an agent that does not exist", async () => {
    expect(await getSkillEnv(asInstanceSlug(`${MARKER}-missing`), SKILL)).toEqual({});
    expect(await hasAllRequiredEnv(asInstanceSlug(`${MARKER}-missing`), SKILL, ["API_KEY"])).toBe(false);
  });
});
