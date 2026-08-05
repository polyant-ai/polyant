// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for syncToolsToDb() namespaced-orphan pruning against a live
 * Postgres. Unlike the unit test (which mocks drizzle and only inspects the
 * query shape), this exercises the real DELETE + the enabled-anywhere guard and
 * proves the safety contract:
 *   - a namespaced plugin tool ENABLED on an instance is preserved (no FK wipe);
 *   - a namespaced tool referenced by NOBODY is pruned;
 *   - virtual `agent:*` rows are never touched;
 *   - flat core rows absent from the registry are still pruned.
 *
 * Self-skips when no migrated database is reachable (so a bare `npm test`
 * without a DB stays green). Run it for real with a database up:
 *   docker compose up -d postgres && npm run db:migrate && npm run test:integration
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { db } from "../../database/client.js";
import { instances } from "../../instances/schema.js";
import { workspaces } from "../../organizations/organization.schema.js";
import { instanceTools } from "../../instances/instance-tools.schema.js";
import { tools } from "./tools.schema.js";
import { syncToolsToDb } from "./tools-sync.js";
import { _resetRegistryForTests, _registerToolForTests } from "./registry.js";
import { asInstanceUuid, type InstanceUuid } from "../../instances/identifiers.js";

const SLUG = "itest-tools-sync";
const CORE = "itestSyncCore"; // in registry → kept
const ORPHAN = "itestsync:orphan"; // namespaced, not enabled → pruned
const KEPT = "itestsync:kept"; // namespaced, enabled on the instance → kept
const AGENT = "agent:itestsync-fake"; // virtual agent row → kept
const FLAT_GONE = "itestSyncFlatGone"; // flat, absent from registry → pruned
const ALL_NAMES = [CORE, ORPHAN, KEPT, AGENT, FLAT_GONE];

/** Seed instance + catalog rows at module load (top-level await) so `it.skipIf`
 *  sees the resolved value — a beforeAll assignment would be too late.
 *  Returns the instance uuid, or undefined when no migrated DB is reachable. */
async function setup(): Promise<InstanceUuid | undefined> {
  try {
    const [ws] = await Promise.race([
      db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("db timeout")), 3000)),
    ]);
    if (!ws) return undefined;

    const rows = await db
      .insert(instances)
      .values({ slug: SLUG, name: "itest tools-sync", workspaceId: ws.id })
      .onConflictDoNothing()
      .returning({ id: instances.id });
    const uuid = rows[0]
      ? rows[0].id
      : (
          await db.select({ id: instances.id }).from(instances).where(eq(instances.slug, SLUG)).limit(1)
        )[0]?.id;
    if (!uuid) return undefined;
    const instanceUuid = asInstanceUuid(uuid);

    // Deterministic registry: only CORE is loaded, so ORPHAN/KEPT/FLAT_GONE count
    // as "absent from the registry" and the main (non-empty) delete branch runs.
    _resetRegistryForTests();
    _registerToolForTests(
      defineTool({ name: CORE, description: "core", parameters: z.object({}), execute: async () => ({}) }),
    );

    // Clean leftovers from a prior failed run, then seed catalog rows + enable KEPT.
    await db.delete(tools).where(inArray(tools.name, ALL_NAMES));
    const seeded = await db
      .insert(tools)
      .values([
        { name: ORPHAN, description: "orphan plugin tool" },
        { name: KEPT, description: "enabled plugin tool" },
        { name: AGENT, description: "virtual agent row", category: "agent" },
        { name: FLAT_GONE, description: "removed core tool" },
      ])
      .returning({ id: tools.id, name: tools.name });

    const keptId = seeded.find((r) => r.name === KEPT)!.id;
    await db.insert(instanceTools).values({ instanceId: instanceUuid, toolId: keptId, source: "manual" });
    return instanceUuid;
  } catch {
    return undefined;
  }
}

const instanceUuid = await setup();

afterAll(async () => {
  if (!instanceUuid) return;
  await db.delete(instances).where(eq(instances.id, instanceUuid)); // cascades instance_tools
  await db.delete(tools).where(inArray(tools.name, ALL_NAMES));
  _resetRegistryForTests();
});

describe("syncToolsToDb (integration): namespaced-orphan pruning", () => {
  it.skipIf(!instanceUuid)(
    "prunes unreferenced namespaced rows, keeps enabled + agent:* rows",
    async () => {
      await syncToolsToDb();

      const remaining = new Set(
        (await db.select({ name: tools.name }).from(tools).where(inArray(tools.name, ALL_NAMES))).map(
          (r) => r.name,
        ),
      );

      expect(remaining.has(ORPHAN)).toBe(false); // orphan pruned
      expect(remaining.has(FLAT_GONE)).toBe(false); // flat-gone pruned
      expect(remaining.has(KEPT)).toBe(true); // enabled → preserved (no FK wipe)
      expect(remaining.has(AGENT)).toBe(true); // virtual agent row untouched
      expect(remaining.has(CORE)).toBe(true); // in registry → upserted
    },
  );
});
