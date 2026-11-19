// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `GET /api/instances/:slug/skills/:skillSlug`, the text the agent's skill drawer
 * shows: the version the agent runs, read against the real database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { queryClient } from "../../database/client.js";
import { resolveDatabaseAvailability } from "../../database/test-db.js";
import { createSkill, updateSkill } from "../../skills/skills.store.js";
import { InstanceSkillsController } from "./instance-skills.controller.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const MARKER = `itest-skill-content-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const AGENT_SLUG = `${MARKER}-agent`;
const SKILL_SLUG = `${MARKER}-booking`;
const SKILL_SLUG_2 = `${MARKER}-invoicing`;
const ARCHIVED_SLUG = `${MARKER}-archived`;
const SLUGS = [SKILL_SLUG, SKILL_SLUG_2, ARCHIVED_SLUG];

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instance_skills WHERE instance_id IN (SELECT id FROM instances WHERE slug = ${AGENT_SLUG})`;
  await queryClient`DELETE FROM instances WHERE slug = ${AGENT_SLUG}`;
  await queryClient`DELETE FROM skill_versions WHERE skill_id IN (SELECT id FROM skills WHERE slug IN ${queryClient(SLUGS)})`;
  await queryClient`DELETE FROM skills WHERE slug IN ${queryClient(SLUGS)}`;
}

describe.skipIf(!DB_AVAILABLE)("instance skills — one skill's text for the drawer (integration)", () => {
  const controller = new InstanceSkillsController();

  beforeAll(async () => {
    await teardown();
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${AGENT_SLUG}, 'Agent', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))`;
    await createSkill({ slug: SKILL_SLUG, name: "Booking", content: "Booking instructions." });
    await createSkill({ slug: SKILL_SLUG_2, name: "Invoicing", content: "Invoicing instructions." });
    await createSkill({ slug: ARCHIVED_SLUG, name: "Archived", content: "Archived instructions." });
    await queryClient`UPDATE skills SET status = 'archived' WHERE slug = ${ARCHIVED_SLUG}`;
  });

  afterAll(teardown);

  beforeEach(async () => {
    await queryClient`DELETE FROM instance_skills WHERE instance_id IN (SELECT id FROM instances WHERE slug = ${AGENT_SLUG})`;
  });

  it("reads the text of a skill the agent has not enabled, at its current version", async () => {
    const skill = await controller.getSkill(AGENT_SLUG, SKILL_SLUG);

    expect(skill).toMatchObject({ name: SKILL_SLUG, version: "0.1.0", content: "Booking instructions." });
  });

  it("reads the version the agent is pinned to after the catalog moved on, the text its turns run", async () => {
    await controller.updateSkills(AGENT_SLUG, { enabled: [SKILL_SLUG_2] });
    const pinned = await controller.getSkill(AGENT_SLUG, SKILL_SLUG_2);
    await updateSkill(SKILL_SLUG_2, { content: "Invoicing, revised." });

    const skill = await controller.getSkill(AGENT_SLUG, SKILL_SLUG_2);

    expect(skill.content).toBe("Invoicing instructions.");
    expect(skill.version).toBe(pinned.version);
  });

  // The list leaves an archived skill out, so the drawer cannot open it either.
  it("answers 404 for an archived skill and for one that does not exist", async () => {
    await expect(controller.getSkill(AGENT_SLUG, ARCHIVED_SLUG)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.getSkill(AGENT_SLUG, `${MARKER}-missing`)).rejects.toBeInstanceOf(NotFoundException);
  });
});
