// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The knowledge document cap an agent gets, against a real Postgres: its own
 * organization's cap when it declares one (above the default too), the
 * deployment default otherwise, and the default for an agent that resolves to
 * nothing, never "no limit". Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { DEFAULT_KNOWLEDGE_DOC_CAP, resolveKnowledgeDocCap } from "./doc-cap.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-doc-cap";

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

async function agentInOrgWithCap(suffix: string, cap: number | null): Promise<string> {
  const slug = `${MARKER}-${suffix}`;
  const [{ id: orgId }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default, knowledge_max_docs_per_agent) VALUES (${slug}, 'c', false, ${cap}) RETURNING id`;
  const [{ id: wsId }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${slug}, 'c', false) RETURNING id`;
  await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${slug}, 'c', ${wsId})`;
  return slug;
}

describe.skipIf(!DB_AVAILABLE)("knowledge document cap (integration)", () => {
  let small: string;
  let large: string;
  let none: string;

  beforeAll(async () => {
    await teardown();
    small = await agentInOrgWithCap("small", 20);
    large = await agentInOrgWithCap("large", 10_000);
    none = await agentInOrgWithCap("none", null);
  });

  afterAll(teardown);

  it("uses the agent's own organization's cap, even above the deployment default", async () => {
    expect(await resolveKnowledgeDocCap(asInstanceSlug(small))).toBe(20);
    expect(await resolveKnowledgeDocCap(asInstanceSlug(large))).toBe(10_000);
  });

  it("falls back to the deployment default when the organization declares none, or the agent resolves to nothing", async () => {
    expect(DEFAULT_KNOWLEDGE_DOC_CAP).toBe(500);
    expect(await resolveKnowledgeDocCap(asInstanceSlug(none))).toBe(500);
    expect(await resolveKnowledgeDocCap(asInstanceSlug(`${MARKER}-missing`))).toBe(500);
  });
});
