// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Agent tools data store — enabled tools per instance
// ---------------------------------------------------------------------------

import { eq, and, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { agentTools } from "./instance-tools.schema.js";
import { agentSkills } from "./instance-skills.schema.js";
import { tools } from "../agents/tools/tools.schema.js";
import { skillVersions } from "../skills/schema.js";
import { DEFAULT_TOOL_NAMES } from "./defaults.js";
import { type AgentUuid } from "./identifiers.js";

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
export async function getEnabledToolNames(agentId: AgentUuid): Promise<Set<string>> {
  const rows = await db
    .select({ name: tools.name })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(eq(agentTools.agentId, agentId));

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
export async function recomputeInstanceTools(agentId: AgentUuid): Promise<void> {
  // 1. Get enabled skills with their PINNED version metadata
  const enabledSkills = await db
    .select({
      skillVersionId: agentSkills.skillVersionId,
      metadata: skillVersions.metadata,
    })
    .from(agentSkills)
    .innerJoin(skillVersions, eq(agentSkills.skillVersionId, skillVersions.id))
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.enabled, true),
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
    .select({ toolId: agentTools.toolId })
    .from(agentTools)
    .where(
      and(
        eq(agentTools.agentId, agentId),
        eq(agentTools.source, "manual"),
      ),
    );

  // 6. Build desired set: globals(source:global) + skill(source:skill) + manuals(source:manual)
  const desiredRows: { agentId: string; toolId: string; source: string }[] = [];
  const seenToolIds = new Set<string>();

  for (const row of globalToolRows) {
    if (!seenToolIds.has(row.id)) {
      seenToolIds.add(row.id);
      desiredRows.push({ agentId, toolId: row.id, source: "global" });
    }
  }

  for (const row of skillToolIds) {
    if (!seenToolIds.has(row.id)) {
      seenToolIds.add(row.id);
      desiredRows.push({ agentId, toolId: row.id, source: "skill" });
    }
  }

  for (const row of manualRows) {
    if (!seenToolIds.has(row.toolId)) {
      seenToolIds.add(row.toolId);
      desiredRows.push({ agentId, toolId: row.toolId, source: "manual" });
    }
  }

  // 7. Diff-based update in transaction (avoids momentary empty state)
  await db.transaction(async (tx) => {
    const current = await tx
      .select({ toolId: agentTools.toolId, source: agentTools.source })
      .from(agentTools)
      .where(eq(agentTools.agentId, agentId));

    const currentSet = new Set(current.map((r) => `${r.toolId}:${r.source}`));
    const desiredSet = new Set(desiredRows.map((r) => `${r.toolId}:${r.source}`));

    // Only delete rows not in the desired set
    const toDelete = current.filter((r) => !desiredSet.has(`${r.toolId}:${r.source}`));
    if (toDelete.length > 0) {
      await tx.delete(agentTools).where(
        and(
          eq(agentTools.agentId, agentId),
          inArray(agentTools.toolId, toDelete.map((r) => r.toolId)),
        ),
      );
    }

    // Only insert rows not in the current set
    const toInsert = desiredRows.filter((r) => !currentSet.has(`${r.toolId}:${r.source}`));
    if (toInsert.length > 0) {
      await tx.insert(agentTools).values(toInsert);
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
export async function seedInstanceTools(agentId: AgentUuid): Promise<void> {
  const toolRows = await db
    .select({ id: tools.id, name: tools.name })
    .from(tools)
    .where(inArray(tools.name, DEFAULT_TOOL_NAMES));

  if (toolRows.length === 0) return;

  const values = toolRows.map((t) => ({
    agentId,
    toolId: t.id,
    source: "manual" as const,
  }));

  await db
    .insert(agentTools)
    .values(values)
    .onConflictDoNothing();
}
