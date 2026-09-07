// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, inArray, sql } from "drizzle-orm";
import { instanceSkills } from "./instance-skills.schema.js";
import { skills, skillVersions } from "../skills/schema.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

async function loadSkillMap(
  tx: TxClient,
  assignments: ExportInstanceData["skills"],
) {
  const slugs = assignments.map((a) => a.skillSlug);
  const skillRows = await tx
    .select({
      id: skills.id,
      slug: skills.slug,
      currentVersionId: skills.currentVersionId,
    })
    .from(skills)
    .where(inArray(skills.slug, slugs));

  return new Map(skillRows.map((r) => [r.slug, r]));
}

async function importOneSkillAssignment(
  tx: TxClient,
  instanceId: string,
  skillMap: Map<string, { id: string; slug: string; currentVersionId: string | null }>,
  assignment: ExportInstanceData["skills"][number],
): Promise<ImportWarning | null> {
  const skill = skillMap.get(assignment.skillSlug);
  if (!skill) {
    return { type: "missing_skill", message: `Skill "${assignment.skillSlug}" not found — skipped` };
  }

  // Try to find the specific pinned version
  const [version] = await tx
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skill.id),
        eq(skillVersions.version, assignment.pinnedVersion),
      ),
    )
    .limit(1);

  // Fall back to current version if pinned version not found
  const versionId = version?.id ?? skill.currentVersionId;
  if (!versionId) {
    return { type: "missing_skill", message: `Skill "${assignment.skillSlug}" has no available version — skipped` };
  }

  await tx
    .insert(instanceSkills)
    .values({
      instanceId,
      skillId: skill.id,
      skillVersionId: versionId,
      enabled: assignment.enabled,
      autoLoad: assignment.autoLoad,
    })
    .onConflictDoUpdate({
      target: [instanceSkills.instanceId, instanceSkills.skillId],
      set: {
        skillVersionId: versionId,
        enabled: assignment.enabled,
        autoLoad: assignment.autoLoad,
        updatedAt: sql`now()`,
      },
    });

  return null;
}

export async function importSkillAssignments(
  tx: TxClient,
  instanceId: string,
  assignments: ExportInstanceData["skills"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];
  if (assignments.length === 0) return warnings;

  const skillMap = await loadSkillMap(tx, assignments);
  for (const assignment of assignments) {
    const warning = await importOneSkillAssignment(tx, instanceId, skillMap, assignment);
    if (warning) warnings.push(warning);
  }

  return warnings;
}
