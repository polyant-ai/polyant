// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  NotFoundException,
} from "@nestjs/common";
import {
  getInstanceSkills,
  enableSkill,
  disableSkill,
  upgradeSkill,
  rollbackSkill,
} from "../../instances/instance-skills.store.js";
import { listSkills as listAllSkills, getSkill as getSkillFromStore } from "../../skills/skills.store.js";
import { getEnabledToolNames } from "../../instances/instance-tools.store.js";
import { setSkillEnv, getSkillEnv, deleteSkillEnv, hasAllRequiredEnvBatch } from "../../instances/skill-env.store.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { asAgentSlug, type AgentSlug, type AgentUuid } from "../../instances/identifiers.js";
import { RequirePermission, Permission } from "../../authz/index.js";

interface RequiredEnvEntry {
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

/** Build the merged skills list with env check status for an instance (used by GET and PATCH). */
async function buildSkillsWithStatus(slug: AgentSlug, agentId: AgentUuid) {
  const allLibrarySkills = await listAllSkills();
  const instanceSkillRows = await getInstanceSkills(agentId);
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

@Controller("api/agents")
export class InstanceSkillsController {
  @RequirePermission(Permission.SKILL_INSTANCE_READ)
  @Get(":slug/skills")
  async getSkills(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const skills = await buildSkillsWithStatus(asAgentSlug(slug), instance.id);
    return { skills };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Patch(":slug/skills")
  async updateSkills(
    @Param("slug") slug: string,
    @Body() body: { enabled: string[] },
  ) {
    const instance = await findInstanceOrFail(slug);
    const enabledSet = new Set(body.enabled);

    // Capture tool set BEFORE changes
    const beforeTools = await getEnabledToolNames(instance.id);

    // Get current skill state
    const beforeSkills = await getInstanceSkills(instance.id);
    const beforeEnabled = new Set(
      beforeSkills.filter((s) => s.enabled).map((s) => s.skillSlug),
    );

    const toEnable: string[] = [];
    const toDisable: string[] = [];
    for (const skillSlug of enabledSet) {
      if (!beforeEnabled.has(skillSlug)) toEnable.push(skillSlug);
    }
    for (const is of beforeSkills) {
      if (is.enabled && !enabledSet.has(is.skillSlug)) toDisable.push(is.skillSlug);
    }
    await Promise.all([
      ...toEnable.map((slug) => enableSkill(instance.id, slug)),
      ...toDisable.map((slug) => disableSkill(instance.id, slug)),
    ]);

    // Capture tool set AFTER changes
    const afterTools = await getEnabledToolNames(instance.id);

    // Compute actual tool diff (not skill diff)
    const toolsChanged = {
      added: [...afterTools].filter((t) => !beforeTools.has(t)),
      removed: [...beforeTools].filter((t) => !afterTools.has(t)),
    };

    const skills = await buildSkillsWithStatus(asAgentSlug(slug), instance.id);
    return { skills, toolsChanged };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Post(":slug/skills/:skillSlug/upgrade")
  async upgrade(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
  ) {
    const instance = await findInstanceOrFail(slug);
    await upgradeSkill(instance.id, skillSlug);
    return { upgraded: true };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Post(":slug/skills/:skillSlug/auto-load")
  async toggleAutoLoad(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
    @Body() body: { autoLoad: boolean },
  ) {
    const instance = await findInstanceOrFail(slug);
    const { setAutoLoad } = await import("../../instances/instance-skills.store.js");
    await setAutoLoad(instance.id, skillSlug, body.autoLoad);
    return { autoLoad: body.autoLoad };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Post(":slug/skills/:skillSlug/rollback")
  async rollback(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
    @Body() body: { versionId: string },
  ) {
    const instance = await findInstanceOrFail(slug);
    await rollbackSkill(instance.id, skillSlug, body.versionId);
    return { rolledBack: true };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_READ)
  @Get(":slug/skills/:skillSlug/env")
  async getSkillEnvVars(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
  ) {
    await findInstanceOrFail(slug);
    const skill = await getSkillFromStore(skillSlug);
    if (!skill) throw new NotFoundException(`Skill "${skillSlug}" not found`);

    const meta = skill.currentVersion?.metadata as { requiredEnv?: RequiredEnvEntry[] } | null;
    const requiredEnv = meta?.requiredEnv ?? [];
    const storedEnv = await getSkillEnv(asAgentSlug(slug), skillSlug);

    const env = requiredEnv.map((entry) => ({
      key: entry.name,
      value: entry.sensitive ? "" : (storedEnv[entry.name] ?? ""),
      sensitive: entry.sensitive,
      configured: entry.name in storedEnv,
      description: entry.description,
    }));
    return { env };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Put(":slug/skills/:skillSlug/env")
  async setSkillEnvVars(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
    @Body() body: { env: { key: string; value: string; sensitive: boolean }[] },
  ) {
    const instance = await findInstanceOrFail(slug);

    for (const entry of body.env) {
      if (entry.value === "" && entry.sensitive) continue;
      await setSkillEnv({
        agentId: instance.id,
        skillSlug,
        key: entry.key,
        value: entry.value,
        sensitive: entry.sensitive,
      });
    }

    const skill = await getSkillFromStore(skillSlug);
    const meta = skill?.currentVersion?.metadata as { requiredEnv?: RequiredEnvEntry[] } | null;
    const requiredEnv = meta?.requiredEnv ?? [];
    const storedEnv = await getSkillEnv(asAgentSlug(slug), skillSlug);

    const env = requiredEnv.map((entry) => ({
      key: entry.name,
      value: entry.sensitive ? "" : (storedEnv[entry.name] ?? ""),
      sensitive: entry.sensitive,
      configured: entry.name in storedEnv,
      description: entry.description,
    }));
    return { env };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Delete(":slug/skills/:skillSlug/env/:key")
  async removeSkillEnvVar(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
    @Param("key") key: string,
  ) {
    const instance = await findInstanceOrFail(slug);
    await deleteSkillEnv(instance.id, skillSlug, key);
    return { deleted: true };
  }
}
