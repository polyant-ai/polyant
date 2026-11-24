// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Seeding an agent's prompt sections against a real Postgres: one row per
 * section, empty except the skills placeholder, safe to run twice or at once,
 * never over a section someone already edited, and visible to the next read.
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { getPrompts, seedInstancePrompts, upsertPrompt } from "./prompts.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-prompts-seed";

async function plant(suffix: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${`${MARKER}-${suffix}`}, 'p', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)) RETURNING id`;
  return asInstanceUuid(row!.id);
}

async function sections(id: InstanceUuid) {
  return queryClient<{ section_key: string; content: string }[]>`
    SELECT section_key, content FROM instance_prompts WHERE instance_id = ${id} ORDER BY section_key`;
}

describe.skipIf(!DB_AVAILABLE)("seeding prompt sections (integration)", () => {
  beforeAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  });

  afterAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  });

  it("seeds every section empty except the skills placeholder", async () => {
    const id = await plant("empty");

    await seedInstancePrompts(id, db);

    const rows = await sections(id);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.content, row.section_key).toBe(row.section_key === "05-skills" ? "{{skillsList}}" : "");
    }
    expect(rows.map((r) => r.section_key)).toContain("05-skills");
  });

  it("leaves one row per section when seeded twice, or twice at once", async () => {
    const id = await plant("twice");

    await Promise.all([seedInstancePrompts(id, db), seedInstancePrompts(id, db)]);
    await seedInstancePrompts(id, db);

    const keys = (await sections(id)).map((r) => r.section_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps a section someone edited, and the next read shows what the seed added", async () => {
    const id = await plant("edited");
    await upsertPrompt(id, "01-identity", "Identity", "You are Ada.");
    expect((await getPrompts(id)).map((p) => p.sectionKey)).toEqual(["01-identity"]);

    await seedInstancePrompts(id, db);

    const prompts = await getPrompts(id);
    expect(prompts.find((p) => p.sectionKey === "01-identity")?.content).toBe("You are Ada.");
    expect(prompts.length).toBe((await sections(id)).length);
    expect(prompts.length).toBeGreaterThan(1);
  });
});
