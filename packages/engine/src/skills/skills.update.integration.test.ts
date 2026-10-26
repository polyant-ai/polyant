// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Editing a skill's name and description against a real Postgres: the display name and
 * description change, a new version is written, and the slug (how agents read the
 * skill) is the same row afterwards. Self-skips without a database.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { SkillsService } from "./skills.service.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = `itest-skill-edit-${Date.now()}`;

describe.skipIf(!DB_AVAILABLE)("skill name and description edit (integration)", () => {
  const service = new SkillsService();

  beforeAll(async () => {
    await service.createSkill({ name: SLUG, description: "before", content: "v1" });
  });

  afterAll(async () => {
    await queryClient`DELETE FROM skills WHERE slug = ${SLUG}`;
  });

  it("changes the display name and description and keeps the slug", async () => {
    const before = await queryClient<{ id: string }[]>`SELECT id FROM skills WHERE slug = ${SLUG}`;
    const updated = await service.updateSkill(SLUG, { displayName: "Research the web", description: "after", content: "v2" });

    expect(updated).toMatchObject({ name: SLUG, displayName: "Research the web", description: "after", content: "v2" });
    const rows = await queryClient<{ id: string; slug: string; name: string }[]>`SELECT id, slug, name FROM skills WHERE slug = ${SLUG}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before[0]!.id, slug: SLUG, name: "Research the web" });
    const versions = await queryClient<{ n: number }[]>`SELECT count(*)::int AS n FROM skill_versions WHERE skill_id = ${before[0]!.id}`;
    expect(versions[0]!.n).toBe(2);
  });

  it("keeps the display name when an edit sends none", async () => {
    await service.updateSkill(SLUG, { description: "again", content: "v3" });
    const [row] = await queryClient<{ name: string; description: string }[]>`SELECT name, description FROM skills WHERE slug = ${SLUG}`;
    expect(row).toMatchObject({ name: "Research the web", description: "again" });
  });
});
