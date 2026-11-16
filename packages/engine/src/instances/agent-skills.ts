// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  disableSkill,
  enableSkill,
  getInstanceSkills,
  setAutoLoad,
} from "./instance-skills.store.js";
import { listSkills as listAllSkills } from "../skills/skills.store.js";
import { getEnabledToolNames } from "./instance-tools.store.js";
import { hasAllRequiredEnvBatch } from "./skill-env.store.js";
import type { InstanceSlug, InstanceUuid } from "./identifiers.js";

/** An environment value a skill declares it needs. */
export interface RequiredEnvEntry {
  name: string;
  description?: string;
  sensitive: boolean;
}

interface SkillMeta {
  requiredEnv: RequiredEnvEntry[];
  requiredTools: string[];
}


/** Batch-load skill metadata (requiredEnv, requiredTools) for a set of skill slugs. */
async function loadSkillMetaMap(slugs: string[]): Promise<Map<string, SkillMeta>> {
  const metaMap = new Map<string, SkillMeta>();
  if (slugs.length === 0) return metaMap;

  // One query for all active skills, then filter in-memory
  const allSkills = await listAllSkills();
  const slugSet = new Set(slugs);
  for (const skill of allSkills) {
    if (!slugSet.has(skill.slug)) continue;
    const meta = skill.currentVersion?.metadata as { requiredEnv?: RequiredEnvEntry[]; requiredTools?: string[] } | null;
    const requiredEnv = meta?.requiredEnv ?? [];
    const requiredTools = meta?.requiredTools ?? [];
    if (requiredEnv.length > 0 || requiredTools.length > 0) {
      metaMap.set(skill.slug, { requiredEnv, requiredTools });
    }
  }
  return metaMap;
}

/**
 * Every active catalog skill with the agent's state for it: enabled, auto-load,
 * whether its required environment is configured, and its pinned version. What
 * the panel's Skills section lists.
 */
export async function listAgentSkills(slug: InstanceSlug, instanceId: InstanceUuid) {
  const allLibrarySkills = await listAllSkills();
  const instanceSkillRows = await getInstanceSkills(instanceId);
  const instanceMap = new Map(instanceSkillRows.map((is) => [is.skillSlug, is]));

  const skillMetaMap = await loadSkillMetaMap(allLibrarySkills.map((s) => s.slug));

  const enabledSlugs = instanceSkillRows.filter((s) => s.enabled).map((s) => s.skillSlug);
  const envChecks = enabledSlugs
    .filter((s) => skillMetaMap.has(s))
    .map((s) => ({
      skillSlug: s,
      keys: skillMetaMap.get(s)!.requiredEnv.map((e) => e.name),
    }));
  const envResults = envChecks.length > 0
    ? await hasAllRequiredEnvBatch(slug, envChecks)
    : new Map<string, boolean>();

  return allLibrarySkills
    .filter((s) => s.status === "active")
    .map((libSkill) => {
      const is = instanceMap.get(libSkill.slug);
      const meta = skillMetaMap.get(libSkill.slug);
      const requiredEnv = meta?.requiredEnv ?? [];
      const requiredTools = meta?.requiredTools ?? [];
      const enabled = is?.enabled ?? false;
      const envKeys = requiredEnv.map((e) => e.name);
      const envConfigured = envKeys.length === 0 || (enabled && (envResults.get(libSkill.slug) ?? false));
      return {
        name: libSkill.slug,
        description: libSkill.description,
        category: libSkill.category,
        requiredEnv: requiredEnv.length > 0 ? requiredEnv : undefined,
        requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
        enabled,
        autoLoad: is?.autoLoad ?? false,
        envConfigured,
        pinnedVersion: is?.pinnedVersion ?? null,
        currentVersion: is?.currentVersion ?? libSkill.currentVersion?.version ?? null,
        hasUpdate: is?.hasUpdate ?? false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * Make `enabled` the agent's exact set of enabled skills: enable the new ones,
 * disable the rest. Enabling a skill can enable the tools it requires, so the
 * tool changes it caused come back with the new list.
 */
export async function setEnabledAgentSkills(slug: InstanceSlug, instanceId: InstanceUuid, enabled: readonly string[]) {
  const enabledSet = new Set(enabled);
  const beforeTools = await getEnabledToolNames(instanceId);
  const beforeSkills = await getInstanceSkills(instanceId);
  const beforeEnabled = new Set(beforeSkills.filter((s) => s.enabled).map((s) => s.skillSlug));

  const toEnable = [...enabledSet].filter((skillSlug) => !beforeEnabled.has(skillSlug));
  const toDisable = beforeSkills.filter((is) => is.enabled && !enabledSet.has(is.skillSlug)).map((is) => is.skillSlug);
  await Promise.all([
    ...toEnable.map((skillSlug) => enableSkill(instanceId, skillSlug)),
    ...toDisable.map((skillSlug) => disableSkill(instanceId, skillSlug)),
  ]);

  const afterTools = await getEnabledToolNames(instanceId);
  const toolsChanged = {
    added: [...afterTools].filter((t) => !beforeTools.has(t)),
    removed: [...beforeTools].filter((t) => !afterTools.has(t)),
  };
  return { skills: await listAgentSkills(slug, instanceId), toolsChanged };
}

/** Whether an enabled skill's full instructions load into every turn instead of on demand. */
export async function setAgentSkillAutoLoad(instanceId: InstanceUuid, skillSlug: string, autoLoad: boolean): Promise<void> {
  await setAutoLoad(instanceId, skillSlug, autoLoad);
}
