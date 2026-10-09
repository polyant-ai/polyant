// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rename_extracted_tools migrations against a real Postgres, followed by the boot
 * sync of an engine that has NOT loaded the plugins yet. The break it catches:
 * an agent that had a HubSpot or PDF tool enabled before the tools moved into
 * plugins loses the enablement, and a skill its tool link, at the first boot —
 * with nothing left in the database to show it.
 *
 * Self-skips when no migrated database is reachable.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { db } from "../../database/client.js";
import { resolveDatabaseAvailability, lockToolsTable } from "../../database/test-db.js";
import { instances } from "../../instances/schema.js";
import { workspaces } from "../../organizations/organization.schema.js";
import { instanceTools } from "../../instances/instance-tools.schema.js";
import { skills, skillVersions, skillTools } from "../../skills/schema.js";
import { tools } from "./tools.schema.js";
import { syncToolsToDb } from "./tools-sync.js";
import { _resetRegistryForTests, _registerToolForTests } from "./registry.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = "itest-rename-extracted";
const SKILL_SLUG = "itest-rename-extracted-skill";
const CORE = "itestRenameCore";
const NAMES = [
  CORE,
  "hubspotContact",
  "hubspot:contact",
  "hubspotNote",
  "hubspot:note",
  "fileUpload",
  "extra:fileUpload",
  "verifyDocument",
];

async function runMigration() {
  const dir = new URL("../../database/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => /_rename_extracted_tools(_[a-z0-9_]+)?\.sql$/.test(f))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) await db.execute(sql.raw(readFileSync(new URL(file, dir), "utf8")));
}

async function enabledNames(instanceId: string) {
  const rows = await db
    .select({ name: tools.name })
    .from(instanceTools)
    .innerJoin(tools, eq(tools.id, instanceTools.toolId))
    .where(eq(instanceTools.instanceId, instanceId));
  return rows.map((r) => r.name).sort();
}

// It prunes namespaced tool rows: exclusive, so no suite seeding its own is running.
const releaseToolsLock = await lockToolsTable("exclusive");
afterAll(async () => {
  await releaseToolsLock();
});

let instanceId: string | undefined;

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  if (instanceId) await db.delete(instances).where(eq(instances.id, instanceId));
  await db.delete(skills).where(eq(skills.slug, SKILL_SLUG));
  await db.delete(tools).where(inArray(tools.name, NAMES));
  _resetRegistryForTests();
});

describe("migrations rename_extracted_tools (integration)", () => {
  it.skipIf(!DB_AVAILABLE)(
    "keeps enablement and skill links across the rename and the first boot without plugins",
    async () => {
      // Leftovers from an earlier failed run.
      await db.delete(skills).where(eq(skills.slug, SKILL_SLUG));
      await db.delete(instances).where(eq(instances.slug, SLUG));
      await db.delete(tools).where(inArray(tools.name, NAMES));

      const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1);
      expect(ws).toBeDefined();
      [{ id: instanceId }] = await db
        .insert(instances)
        .values({ slug: SLUG, name: "itest rename", workspaceId: ws!.id })
        .returning({ id: instances.id });

      // A 1.1 catalog: flat rows, plus a namespaced row that already exists
      // because the HubSpot plugin was loaded once before the upgrade.
      const seeded = await db
        .insert(tools)
        .values([
          { name: "hubspotContact", description: "old" },
          { name: "hubspotNote", description: "old" },
          { name: "hubspot:note", description: "plugin" },
          { name: "fileUpload", description: "old" },
          { name: "verifyDocument", description: "removed" },
        ])
        .returning({ id: tools.id, name: tools.name });
      const id = (name: string) => seeded.find((r) => r.name === name)!.id;

      await db.insert(instanceTools).values(
        ["hubspotContact", "hubspotNote", "fileUpload", "verifyDocument"].map((name) => ({
          instanceId: instanceId!,
          toolId: id(name),
          source: "manual",
        })),
      );

      const [skill] = await db
        .insert(skills)
        .values({ slug: SKILL_SLUG, name: "itest rename skill" })
        .returning({ id: skills.id });
      const [version] = await db
        .insert(skillVersions)
        .values({
          skillId: skill!.id,
          version: "0.1.0",
          content: "x",
          // The new name already present too: the rename must not duplicate it.
          metadata: { requiredTools: ["webSearch", "hubspotContact", "hubspot:contact", "hubspotNote"] },
        })
        .returning({ id: skillVersions.id });
      await db.insert(skillTools).values([
        { skillId: skill!.id, toolId: id("hubspotContact") },
        { skillId: skill!.id, toolId: id("hubspotNote") },
      ]);

      await runMigration();
      // A second run finds nothing to rename and changes nothing.
      await runMigration();

      // Renamed in place: the same row, so the links on it never moved.
      const [contact] = await db.select({ id: tools.id }).from(tools).where(eq(tools.name, "hubspot:contact"));
      expect(contact?.id).toBe(id("hubspotContact"));
      expect(await enabledNames(instanceId!)).toEqual([
        "extra:fileUpload",
        "hubspot:contact",
        "hubspot:note",
        "verifyDocument",
      ]);

      const links = await db
        .select({ name: tools.name })
        .from(skillTools)
        .innerJoin(tools, eq(tools.id, skillTools.toolId))
        .where(eq(skillTools.skillId, skill!.id));
      expect(links.map((r) => r.name).sort()).toEqual(["hubspot:contact", "hubspot:note"]);

      const [meta] = await db.select({ metadata: skillVersions.metadata }).from(skillVersions).where(eq(skillVersions.id, version!.id));
      expect(meta?.metadata).toEqual({ requiredTools: ["webSearch", "hubspot:contact", "hubspot:note"] });

      // First boot of an engine without the plugins: only the core tool loads.
      _resetRegistryForTests();
      _registerToolForTests(
        defineTool({ name: CORE, description: "core", parameters: z.object({}), execute: async () => ({}) }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await syncToolsToDb();
      const warnings = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();

      // The renamed rows survive, enabled, until the plugin is installed; the
      // tool with no successor is dropped, and the boot says which one it was.
      expect(await enabledNames(instanceId!)).toEqual(["extra:fileUpload", "hubspot:contact", "hubspot:note"]);
      expect(warnings.some((w) => w.includes("verifyDocument"))).toBe(true);
    },
  );
});
