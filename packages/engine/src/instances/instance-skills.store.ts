// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Agent skills data store — instance <-> skill assignments
// ---------------------------------------------------------------------------

import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { agentSkills } from "./instance-skills.schema.js";
import { skills, skillVersions } from "../skills/schema.js";
import { recomputeInstanceTools } from "./instance-tools.store.js";
import { DEFAULT_SKILL_SLUGS } from "./defaults.js";
import { asAgentUuid, type AgentUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstanceSkillRow {
  id: string;
  agentId: AgentUuid;
  skillId: string;
  skillSlug: string;
  skillName: string;
  skillVersionId: string;
  pinnedVersion: string;
  currentVersion: string | null;
  enabled: boolean;
  autoLoad: boolean;
  hasUpdate: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Get all skills for an instance with version info and upgrade availability. */
export async function getInstanceSkills(agentId: AgentUuid): Promise<InstanceSkillRow[]> {
  // Alias for pinned version
  const pinnedVer = skillVersions;

  const rows = await db
    .select({
      id: agentSkills.id,
      agentId: agentSkills.agentId,
      skillId: agentSkills.skillId,
      skillSlug: skills.slug,
      skillName: skills.name,
      skillVersionId: agentSkills.skillVersionId,
      pinnedVersion: pinnedVer.version,
      currentVersionId: skills.currentVersionId,
      enabled: agentSkills.enabled,
      autoLoad: agentSkills.autoLoad,
      createdAt: agentSkills.createdAt,
      updatedAt: agentSkills.updatedAt,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .innerJoin(pinnedVer, eq(agentSkills.skillVersionId, pinnedVer.id))
    .where(eq(agentSkills.agentId, agentId));

  // Batch-fetch current version strings to avoid N+1
  const currentVersionIds = [...new Set(
    rows.map((r) => r.currentVersionId).filter((id): id is string => id !== null),
  )];

  const currentVersionMap = new Map<string, string>();
  if (currentVersionIds.length > 0) {
    const cvRows = await db
      .select({ id: skillVersions.id, version: skillVersions.version })
      .from(skillVersions)
      .where(inArray(skillVersions.id, currentVersionIds));
    for (const cv of cvRows) {
      currentVersionMap.set(cv.id, cv.version);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    agentId: asAgentUuid(row.agentId),
    skillId: row.skillId,
    skillSlug: row.skillSlug,
    skillName: row.skillName,
    skillVersionId: row.skillVersionId,
    pinnedVersion: row.pinnedVersion,
    currentVersion: row.currentVersionId ? (currentVersionMap.get(row.currentVersionId) ?? null) : null,
    enabled: row.enabled,
    autoLoad: row.autoLoad,
    hasUpdate: row.currentVersionId !== null && row.currentVersionId !== row.skillVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Enable a skill for an instance.
 * Pins to the skill's current_version_id, then recomputes instance tools.
 */
export async function enableSkill(agentId: AgentUuid, skillSlug: string): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id, currentVersionId: skills.currentVersionId })
    .from(skills)
    .where(eq(skills.slug, skillSlug))
    .limit(1);

  if (!skill) throw new Error(`Skill "${skillSlug}" not found`);
  if (!skill.currentVersionId) throw new Error(`Skill "${skillSlug}" has no published version`);

  await db
    .insert(agentSkills)
    .values({
      agentId,
      skillId: skill.id,
      skillVersionId: skill.currentVersionId,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [agentSkills.agentId, agentSkills.skillId],
      set: { enabled: true, updatedAt: sql`now()` },
    });

  await recomputeInstanceTools(agentId);
}

/**
 * Disable a skill for an instance.
 * Marks as disabled (keeps the row for history), then recomputes instance tools.
 */
export async function disableSkill(agentId: AgentUuid, skillSlug: string): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.slug, skillSlug))
    .limit(1);

  if (!skill) return;

  await db
    .update(agentSkills)
    .set({ enabled: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.skillId, skill.id),
      ),
    );

  await recomputeInstanceTools(agentId);
}

/**
 * Shared helper: look up skill + assignment, resolve target version, pin it, recompute tools.
 * `resolveTargetVersionId` receives the skill row and returns the target version ID (or null to abort).
 */
async function pinSkillVersion(
  agentId: AgentUuid,
  skillSlug: string,
  resolveTargetVersionId: (skill: { id: string; currentVersionId: string | null }) => Promise<string | null>,
): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id, currentVersionId: skills.currentVersionId })
    .from(skills)
    .where(eq(skills.slug, skillSlug))
    .limit(1);

  if (!skill) return;

  const targetVersionId = await resolveTargetVersionId(skill);
  if (!targetVersionId) return;

  const [assignment] = await db
    .select({ skillVersionId: agentSkills.skillVersionId })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.skillId, skill.id),
      ),
    )
    .limit(1);

  if (!assignment) return;

  const oldVersionId = assignment.skillVersionId;

  await db
    .update(agentSkills)
    .set({ skillVersionId: targetVersionId, updatedAt: sql`now()` })
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.skillId, skill.id),
      ),
    );

  if (oldVersionId !== targetVersionId) {
    await recomputeInstanceTools(agentId);
  }
}

/**
 * Upgrade a skill to the latest version.
 * Updates skill_version_id to current_version_id, recomputes tools if deps changed.
 */
export async function upgradeSkill(agentId: AgentUuid, skillSlug: string): Promise<void> {
  await pinSkillVersion(agentId, skillSlug, async (skill) => skill.currentVersionId);
}

/**
 * Rollback a skill to a specific version.
 * Sets skill_version_id to the specified version, recomputes if deps changed.
 */
export async function rollbackSkill(
  agentId: AgentUuid,
  skillSlug: string,
  versionId: string,
): Promise<void> {
  await pinSkillVersion(agentId, skillSlug, async (skill) => {
    // Verify the version exists and belongs to this skill
    const [version] = await db
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.id, versionId),
          eq(skillVersions.skillId, skill.id),
        ),
      )
      .limit(1);

    if (!version) throw new Error(`Version "${versionId}" not found for skill "${skillSlug}"`);
    return versionId;
  });
}

/**
 * Set the autoLoad flag for a skill on an instance.
 * When autoLoad is true, the full skill content is injected into the system prompt.
 */
export async function setAutoLoad(
  agentId: AgentUuid,
  skillSlug: string,
  autoLoad: boolean,
): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.slug, skillSlug))
    .limit(1);

  if (!skill) throw new Error(`Skill "${skillSlug}" not found`);

  await db
    .update(agentSkills)
    .set({ autoLoad, updatedAt: sql`now()` })
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.skillId, skill.id),
      ),
    );
}

/**
 * Seed default skills for a new instance.
 * Enables DEFAULT_SKILL_SLUGS, pinning each to the current version.
 * Silently skips skills that don't exist in DB yet.
 */
export async function seedInstanceSkills(agentId: AgentUuid): Promise<void> {
  if (DEFAULT_SKILL_SLUGS.length === 0) return;

  const defaultSkills = await db
    .select({ id: skills.id, slug: skills.slug, currentVersionId: skills.currentVersionId })
    .from(skills)
    .where(inArray(skills.slug, DEFAULT_SKILL_SLUGS));

  for (const skill of defaultSkills) {
    if (!skill.currentVersionId) continue;

    await db
      .insert(agentSkills)
      .values({
        agentId,
        skillId: skill.id,
        skillVersionId: skill.currentVersionId,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [agentSkills.agentId, agentSkills.skillId],
        set: { enabled: true, updatedAt: sql`now()` },
      });
  }

  await recomputeInstanceTools(agentId);
}
