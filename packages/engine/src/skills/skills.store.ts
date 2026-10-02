// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Skills data store — CRUD for skills + skill_versions + skill_tools
// ---------------------------------------------------------------------------

import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { skills, skillVersions, skillTools } from "./schema.js";
import { tools } from "../agents/tools/tools.schema.js";
import { currentToolName } from "../agents/tools/renamed-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  currentVersionId: string | null;
  status: string;
  isDefault: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface SkillVersionRow {
  id: string;
  skillId: string;
  version: string;
  content: string;
  metadata: unknown;
  scripts: { file: string; description: string; content: string }[];
  changelog: string | null;
  createdAt: Date | null;
}

export interface SkillWithVersion extends SkillRow {
  currentVersion: SkillVersionRow | null;
}

export interface CreateSkillInput {
  slug: string;
  name: string;
  description?: string;
  category?: string;
  content: string;
  metadata?: Record<string, unknown>;
  scripts?: { file: string; description: string; content: string }[];
  isDefault?: boolean;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  category?: string;
  content: string;
  metadata?: Record<string, unknown>;
  scripts?: { file: string; description: string; content: string }[];
  changelog?: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Get a skill by slug with its current version content. */
export async function getSkill(slug: string): Promise<SkillWithVersion | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(eq(skills.slug, slug))
    .limit(1);

  if (!row) return null;

  let currentVersion: SkillVersionRow | null = null;
  if (row.currentVersionId) {
    const [vRow] = await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, row.currentVersionId))
      .limit(1);
    currentVersion = vRow ?? null;
  }

  return { ...row, currentVersion };
}

/** List all active skills with current version info. */
export async function listSkills(): Promise<SkillWithVersion[]> {
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.status, "active"))
    .orderBy(sql`LOWER(${skills.name})`);

  // Batch-fetch all current versions to avoid N+1
  const versionIds = [...new Set(
    rows.map((r) => r.currentVersionId).filter((id): id is string => id !== null),
  )];

  const versionMap = new Map<string, SkillVersionRow>();
  if (versionIds.length > 0) {
    const vRows = await db
      .select()
      .from(skillVersions)
      .where(inArray(skillVersions.id, versionIds));
    for (const v of vRows) {
      versionMap.set(v.id, v);
    }
  }

  return rows.map((row) => ({
    ...row,
    currentVersion: row.currentVersionId ? (versionMap.get(row.currentVersionId) ?? null) : null,
  }));
}

/** Get a specific version of a skill. */
export async function getSkillVersion(
  skillId: string,
  version: string,
): Promise<SkillVersionRow | null> {
  const [row] = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** List all versions for a skill. */
export async function listVersions(skillId: string): Promise<SkillVersionRow[]> {
  return db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .orderBy(skillVersions.createdAt);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a new skill with initial version 0.1.0.
 * Sets current_version_id and syncs skill_tools.
 */
export async function createSkill(data: CreateSkillInput): Promise<SkillWithVersion> {
  const metadata = withCurrentToolNames(data.metadata ?? {});
  const scriptEntries = data.scripts ?? [];

  return db.transaction(async (tx) => {
    // Insert skill
    const [skill] = await tx
      .insert(skills)
      .values({
        slug: data.slug,
        name: data.name,
        description: data.description ?? "",
        category: data.category ?? "general",
        isDefault: data.isDefault ?? false,
      })
      .returning();

    // Insert initial version
    const [version] = await tx
      .insert(skillVersions)
      .values({
        skillId: skill.id,
        version: "0.1.0",
        content: data.content,
        metadata,
        scripts: scriptEntries,
      })
      .returning();

    // Update skill with current_version_id
    await tx
      .update(skills)
      .set({ currentVersionId: version.id })
      .where(eq(skills.id, skill.id));

    // Sync skill_tools
    const requiredToolNames = (metadata as { requiredTools?: string[] }).requiredTools ?? [];
    if (requiredToolNames.length > 0) {
      await syncSkillToolsInTx(tx, skill.id, requiredToolNames);
    }

    return {
      ...skill,
      currentVersionId: version.id,
      currentVersion: version,
    };
  });
}

/**
 * Update a skill by creating a NEW version (auto-increment minor).
 * Updates current_version_id and re-syncs skill_tools.
 */
export async function updateSkill(
  slug: string,
  data: UpdateSkillInput,
): Promise<SkillWithVersion | null> {
  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.slug, slug))
    .limit(1);

  if (!skill) return null;

  const metadata = withCurrentToolNames(data.metadata ?? {});
  const scriptEntries = data.scripts ?? [];

  return db.transaction(async (tx) => {
    // Determine next version inside transaction to avoid race conditions
    const latestVersions = await tx
      .select({ version: skillVersions.version })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skill.id))
      .orderBy(sql`${skillVersions.createdAt} DESC`)
      .limit(1);

    const nextVersion = incrementMinor(latestVersions[0]?.version ?? "0.0.0");
    // Update skill fields if provided
    const updates: Record<string, unknown> = { updatedAt: sql`now()` };
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.category !== undefined) updates.category = data.category;

    // Insert new version
    const [version] = await tx
      .insert(skillVersions)
      .values({
        skillId: skill.id,
        version: nextVersion,
        content: data.content,
        metadata,
        scripts: scriptEntries,
        changelog: data.changelog ?? null,
      })
      .returning();

    updates.currentVersionId = version.id;

    const [updatedSkill] = await tx
      .update(skills)
      .set(updates)
      .where(eq(skills.id, skill.id))
      .returning();

    // Re-sync skill_tools
    const requiredToolNames = (metadata as { requiredTools?: string[] }).requiredTools ?? [];
    await syncSkillToolsInTx(tx, skill.id, requiredToolNames);

    return {
      ...updatedSkill,
      currentVersion: version,
    };
  });
}

/**
 * Sync skill_tools junction table.
 * Deletes all existing entries, inserts new ones by resolving tool names to IDs.
 */
export async function syncSkillTools(
  skillId: string,
  requiredToolNames: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await syncSkillToolsInTx(tx, skillId, requiredToolNames);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function syncSkillToolsInTx(
  tx: TxClient,
  skillId: string,
  requiredToolNames: string[],
): Promise<void> {
  // Delete existing
  await tx.delete(skillTools).where(eq(skillTools.skillId, skillId));

  if (requiredToolNames.length === 0) return;

  // Resolve tool names to IDs, under the name the tool has now.
  const toolRows = await tx
    .select({ id: tools.id })
    .from(tools)
    .where(inArray(tools.name, [...new Set(requiredToolNames.map(currentToolName))]));

  if (toolRows.length === 0) return;

  await tx.insert(skillTools).values(
    toolRows.map((t) => ({
      skillId,
      toolId: t.id,
    })),
  );
}

/**
 * `metadata` with `requiredTools` under the names the tools have now. A skills
 * bundle exported before the tools moved into plugins names them flat; the
 * migration renamed stored versions in place, and an import has to do the
 * same, or the link resolves no catalog row and the prompt reports the tool
 * missing on every agent. Order is kept and a duplicate the rename creates is
 * dropped, as the migration does.
 */
function withCurrentToolNames(metadata: Record<string, unknown>): Record<string, unknown> {
  const required = metadata.requiredTools;
  if (!Array.isArray(required)) return metadata;
  const renamed = [
    ...new Set(required.map((name) => (typeof name === "string" ? currentToolName(name) : name))),
  ];
  return { ...metadata, requiredTools: renamed };
}

/** Increment the minor version: "0.1.0" → "0.2.0", "1.3.2" → "1.4.0". */
function incrementMinor(version: string): string {
  const parts = version.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = (parts[1] ?? 0) + 1;
  return `${major}.${minor}.0`;
}
