// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Instance tools data store — enabled tools per instance
// ---------------------------------------------------------------------------

import { eq, and, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { instanceTools } from "./instance-tools.schema.js";
import { instanceSkills } from "./instance-skills.schema.js";
import { tools } from "../agents/tools/tools.schema.js";
import { skillVersions } from "../skills/schema.js";
import { DEFAULT_TOOL_NAMES } from "./defaults.js";
import { type InstanceUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillVersionMetadata {
  requiredTools?: string[];
  requiredEnv?: unknown[];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Get the set of enabled tool names for an instance. */
export async function getEnabledToolNames(instanceId: InstanceUuid): Promise<Set<string>> {
  const rows = await db
    .select({ name: tools.name })
    .from(instanceTools)
    .innerJoin(tools, eq(instanceTools.toolId, tools.id))
    .where(eq(instanceTools.instanceId, instanceId));

  return new Set(rows.map((r) => r.name));
}

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

/**
 * Recompute the full set of enabled tools for an instance.
 *
 * Algorithm:
 * 1. Gather global tools (is_global = true)
 * 2. Gather skill-required tools from PINNED versions
 * 3. Gather manually-added tools
 * 4. Replace all rows in a transaction
 */
export async function recomputeInstanceTools(instanceId: InstanceUuid): Promise<void> {
  // 1. Get enabled skills with their PINNED version metadata
  const enabledSkills = await db
    .select({
      skillVersionId: instanceSkills.skillVersionId,
      metadata: skillVersions.metadata,
    })
    .from(instanceSkills)
    .innerJoin(skillVersions, eq(instanceSkills.skillVersionId, skillVersions.id))
    .where(
      and(
        eq(instanceSkills.instanceId, instanceId),
        eq(instanceSkills.enabled, true),
      ),
    );

  // 2. Collect required tool names from pinned versions
  const skillRequiredToolNames = new Set<string>();
  for (const row of enabledSkills) {
    const meta = row.metadata as SkillVersionMetadata | null;
    if (meta?.requiredTools) {
      for (const toolName of meta.requiredTools) {
        skillRequiredToolNames.add(toolName);
      }
    }
  }

  // 3. Resolve tool IDs for skill-required tools
  let skillToolIds: { id: string; name: string }[] = [];
  if (skillRequiredToolNames.size > 0) {
    skillToolIds = await db
      .select({ id: tools.id, name: tools.name })
      .from(tools)
      .where(inArray(tools.name, [...skillRequiredToolNames]));
  }

  // 4. Get global tool IDs
  const globalToolRows = await db
    .select({ id: tools.id })
    .from(tools)
    .where(eq(tools.isGlobal, true));

  // 5. Get manual tool rows (preserve them)
  const manualRows = await db
    .select({ toolId: instanceTools.toolId })
    .from(instanceTools)
    .where(
      and(
        eq(instanceTools.instanceId, instanceId),
        eq(instanceTools.source, "manual"),
      ),
    );

  // 6. Build desired set: globals(source:global) + skill(source:skill) + manuals(source:manual)
  const desiredRows: { instanceId: string; toolId: string; source: string }[] = [];
  const seenToolIds = new Set<string>();

  for (const row of globalToolRows) {
    if (!seenToolIds.has(row.id)) {
      seenToolIds.add(row.id);
      desiredRows.push({ instanceId, toolId: row.id, source: "global" });
    }
  }

  for (const row of skillToolIds) {
    if (!seenToolIds.has(row.id)) {
      seenToolIds.add(row.id);
      desiredRows.push({ instanceId, toolId: row.id, source: "skill" });
    }
  }

  for (const row of manualRows) {
    if (!seenToolIds.has(row.toolId)) {
      seenToolIds.add(row.toolId);
      desiredRows.push({ instanceId, toolId: row.toolId, source: "manual" });
    }
  }

  // 7. Diff-based update in transaction (avoids momentary empty state)
  await db.transaction(async (tx) => {
    const current = await tx
      .select({ toolId: instanceTools.toolId, source: instanceTools.source })
      .from(instanceTools)
      .where(eq(instanceTools.instanceId, instanceId));

    const currentSet = new Set(current.map((r) => `${r.toolId}:${r.source}`));
    const desiredSet = new Set(desiredRows.map((r) => `${r.toolId}:${r.source}`));

    // Only delete rows not in the desired set
    const toDelete = current.filter((r) => !desiredSet.has(`${r.toolId}:${r.source}`));
    if (toDelete.length > 0) {
      await tx.delete(instanceTools).where(
        and(
          eq(instanceTools.instanceId, instanceId),
          inArray(instanceTools.toolId, toDelete.map((r) => r.toolId)),
        ),
      );
    }

    // Only insert rows not in the current set
    const toInsert = desiredRows.filter((r) => !currentSet.has(`${r.toolId}:${r.source}`));
    if (toInsert.length > 0) {
      await tx.insert(instanceTools).values(toInsert);
    }
  });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Seed instance tools using DEFAULT_TOOL_NAMES.
 * Resolves tool names to IDs, inserts as source='manual'.
 */
export async function seedInstanceTools(instanceId: InstanceUuid): Promise<void> {
  const toolRows = await db
    .select({ id: tools.id, name: tools.name })
    .from(tools)
    .where(inArray(tools.name, DEFAULT_TOOL_NAMES));

  if (toolRows.length === 0) return;

  const values = toolRows.map((t) => ({
    instanceId,
    toolId: t.id,
    source: "manual" as const,
  }));

  await db
    .insert(instanceTools)
    .values(values)
    .onConflictDoNothing();
}
