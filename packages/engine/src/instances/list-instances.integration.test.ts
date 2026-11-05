// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An organization's agent list is in name order, ignoring case, and holds only
 * that organization's agents.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { listAllInstances } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = `itest-listinst-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedOrg(label: string, names: string[]): Promise<string> {
  const slug = `${MARKER}-${label}`;
  const [{ id: orgId }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${slug}, ${slug}, false) RETURNING id`;
  const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${slug}, ${slug}, false) RETURNING id`;
  for (const [i, name] of names.entries()) {
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${`${slug}-a${i}`}, ${name}, ${workspaceId})`;
  }
  return orgId;
}

describe.skipIf(!DB_AVAILABLE)("listAllInstances (integration)", () => {
  let orgId = "";

  beforeAll(async () => {
    orgId = await seedOrg("org", ["beta", "Alpha", "gamma", "Delta"]);
    await seedOrg("other", ["Aardvark"]);
  });

  afterAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
  });

  it("lists the organization's agents by name, whatever the case", async () => {
    const agents = await listAllInstances(orgId);

    expect(agents.map((a) => a.name)).toEqual(["Alpha", "beta", "Delta", "gamma"]);
  });
});
