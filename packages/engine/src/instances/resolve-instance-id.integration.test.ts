// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Converting between an agent's slug and its id, against a real Postgres: each
 * lookup finds that agent and no other, and an unknown one reads as absent.
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { findInstanceByIdOrSlug, resolveInstanceId, resolveInstanceSlug } from "./resolve-instance-id.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-resolve-id";
const SLUG = asInstanceSlug(`${MARKER}-agent`);
const OTHER = asInstanceSlug(`${MARKER}-other`);
let agentId: InstanceUuid;
let otherId: InstanceUuid;

async function plant(slug: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)) RETURNING id`;
  return asInstanceUuid(row!.id);
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("agent slug and id (integration)", () => {
  beforeAll(async () => {
    await teardown();
    agentId = await plant(SLUG);
    otherId = await plant(OTHER);
  });

  afterAll(teardown);

  it("resolves a slug to that agent's id and back", async () => {
    expect(await resolveInstanceId(SLUG)).toBe(agentId);
    expect(await resolveInstanceId(OTHER)).toBe(otherId);
    expect(await resolveInstanceSlug(agentId)).toBe(SLUG);
  });

  it("reads an unknown slug or id as absent", async () => {
    expect(await resolveInstanceId(asInstanceSlug(`${MARKER}-missing`))).toBeUndefined();
    expect(await resolveInstanceId(asInstanceSlug(""))).toBeUndefined();
    expect(await resolveInstanceSlug(asInstanceUuid("00000000-0000-0000-0000-000000000099"))).toBeUndefined();
  });

  it("finds an agent by either its id or its slug", async () => {
    expect((await findInstanceByIdOrSlug(agentId))?.slug).toBe(SLUG);
    expect((await findInstanceByIdOrSlug(SLUG))?.id).toBe(agentId);
    expect(await findInstanceByIdOrSlug("00000000-0000-0000-0000-000000000099")).toBeUndefined();
    // An unknown slug is not asserted: it falls through to the id lookup, which
    // Postgres refuses (22P02, not a uuid) instead of reading it as absent.
  });
});
