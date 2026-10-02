// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A skills bundle exported before the HubSpot, GitHub, Render and PDF tools
 * moved into plugins names them flat. The import looked those names up as
 * written, so the skill lost its tool link and kept the old name in
 * `requiredTools`, where the prompt compares it with the enabled tools and
 * reports it missing on every agent.
 *
 * Self-skips without a database; CI_REQUIRE_DB makes an absent database a failure there.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { importSkillsCatalog } from "./skills-export.service.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = "itest-legacy-skill-bundle";
// One real pair from the rename list, written out here rather than read from it.
const OLD_NAME = "hubspotNote";
const NEW_NAME = "hubspot:note";
const OTHER = "itestLegacySkillOther";

let createdToolNames: string[] = [];

function legacyBundle(version: string, requiredTools: string[]) {
  return {
    version: "1.0",
    exportedAt: "2026-01-01T00:00:00.000Z",
    type: "skills",
    skills: [
      {
        slug: SLUG,
        name: "Legacy skill",
        description: "",
        category: "general",
        isDefault: false,
        versions: [{ version, content: "Use the CRM.", metadata: { requiredTools }, scripts: [], changelog: null }],
      },
    ],
  };
}

async function storedState(): Promise<{ requiredTools: unknown; linked: string[] }> {
  const [row] = await queryClient<{ metadata: { requiredTools?: unknown } }[]>`
    SELECT sv.metadata FROM skills s JOIN skill_versions sv ON sv.id = s.current_version_id WHERE s.slug = ${SLUG}`;
  const links = await queryClient<{ name: string }[]>`
    SELECT t.name FROM skills s
    JOIN skill_tools st ON st.skill_id = s.id
    JOIN tools t ON t.id = st.tool_id
    WHERE s.slug = ${SLUG} ORDER BY t.name`;
  return { requiredTools: row?.metadata.requiredTools, linked: links.map((l) => l.name) };
}

describe.skipIf(!DB_AVAILABLE)("skills catalog import of a bundle written before the tool renames", () => {
  beforeAll(async () => {
    await queryClient`DELETE FROM skills WHERE slug = ${SLUG}`;
    const inserted = await queryClient<{ name: string }[]>`
      INSERT INTO tools (name, description) VALUES (${NEW_NAME}, 'renamed plugin tool'), (${OTHER}, 'other tool')
      ON CONFLICT (name) DO NOTHING RETURNING name`;
    createdToolNames = inserted.map((r) => r.name);
  });

  afterAll(async () => {
    await queryClient`DELETE FROM skills WHERE slug = ${SLUG}`;
    if (createdToolNames.length > 0) await queryClient`DELETE FROM tools WHERE name = ANY(${createdToolNames})`;
  });

  it("links and lists the tool under its current name when the skill is created", async () => {
    await importSkillsCatalog(legacyBundle("1.0.0", [OLD_NAME, OTHER]));

    expect(await storedState()).toEqual({ requiredTools: [NEW_NAME, OTHER], linked: [NEW_NAME, OTHER].sort() });
  });

  it("does the same when the import updates an existing skill", async () => {
    await importSkillsCatalog(legacyBundle("2.0.0", [OLD_NAME, NEW_NAME]));

    // Both spellings name one tool: it is listed and linked once.
    expect(await storedState()).toEqual({ requiredTools: [NEW_NAME], linked: [NEW_NAME] });
  });
});
