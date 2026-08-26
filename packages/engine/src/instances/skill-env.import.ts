// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and } from "drizzle-orm";
import { instanceSkillEnv } from "./skill-env.schema.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

async function importOneSkillEnvVar(
  tx: TxClient,
  instanceId: string,
  env: ExportInstanceData["skillEnv"][number],
): Promise<ImportWarning | null> {
  if (env.encrypted) {
    return {
      type: "skill_env_required",
      message: `Skill env "${env.skillSlug}.${env.key}" (encrypted) needs to be configured`,
    };
  }

  // Non-encrypted values can be imported directly
  await tx
    .insert(instanceSkillEnv)
    .values({
      instanceId,
      skillSlug: env.skillSlug,
      key: env.key,
      value: env.value ?? "",
      encrypted: false,
    })
    .onConflictDoUpdate({
      target: [instanceSkillEnv.instanceId, instanceSkillEnv.skillSlug, instanceSkillEnv.key],
      set: { value: env.value ?? "", encrypted: false, updatedAt: new Date() },
    });

  return null;
}

export async function importSkillEnv(
  tx: TxClient,
  instanceId: string,
  envVars: ExportInstanceData["skillEnv"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const env of envVars) {
    const warning = await importOneSkillEnvVar(tx, instanceId, env);
    if (warning) warnings.push(warning);
  }

  return warnings;
}

async function deleteNonEncryptedSkillEnv(tx: TxClient, instanceId: string): Promise<void> {
  const nonEncryptedRows = await tx
    .select({ id: instanceSkillEnv.id })
    .from(instanceSkillEnv)
    .where(
      and(
        eq(instanceSkillEnv.instanceId, instanceId),
        eq(instanceSkillEnv.encrypted, false),
      ),
    );

  if (nonEncryptedRows.length > 0) {
    await tx
      .delete(instanceSkillEnv)
      .where(
        and(
          eq(instanceSkillEnv.instanceId, instanceId),
          eq(instanceSkillEnv.encrypted, false),
        ),
      );
  }
}

export async function importSkillEnvOverwrite(
  tx: TxClient,
  instanceId: string,
  envVars: ExportInstanceData["skillEnv"],
): Promise<void> {
  // Delete only non-encrypted env vars (keep encrypted ones intact), then
  // import non-encrypted values from the bundle.
  await deleteNonEncryptedSkillEnv(tx, instanceId);

  for (const env of envVars) {
    if (env.encrypted) continue;

    await tx
      .insert(instanceSkillEnv)
      .values({
        instanceId,
        skillSlug: env.skillSlug,
        key: env.key,
        value: env.value ?? "",
        encrypted: false,
      })
      .onConflictDoNothing();
  }
}
