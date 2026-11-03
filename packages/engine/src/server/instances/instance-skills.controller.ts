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
  BadRequestException,
} from "@nestjs/common";
import { z } from "zod";
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
import { asInstanceSlug, type InstanceSlug, type InstanceUuid } from "../../instances/identifiers.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { parseBody } from "../utils/parse-body.js";

/** The complete list of skills the agent keeps. Required: a missing list would read as "none". */
const UpdateSkillsSchema = z.object({ enabled: z.array(z.string()) });
const AutoLoadSchema = z.object({ autoLoad: z.boolean() });
const RollbackSchema = z.object({ versionId: z.string().min(1) });
/** `sensitive` is required: without it a secret would be stored in clear. */
const SetSkillEnvSchema = z.object({
  env: z.array(z.object({ key: z.string().min(1), value: z.string(), sensitive: z.boolean() })),
});

interface RequiredEnvEntry {
  name: string;
  description?: string;
  sensitive: boolean;
}

interface SkillMeta {
  requiredEnv: RequiredEnvEntry[];
  requiredTools: string[];
}

/**
 * What the panel shows for each declared key. A sensitive value is never echoed.
 * `sensitive` is always a boolean, because the panel sends it back on save; a
 * skill whose metadata omits it declares a plain setting.
 */
function envStatus(requiredEnv: readonly RequiredEnvEntry[], storedEnv: Record<string, string>) {
  return requiredEnv.map((entry) => {
    const sensitive = entry.sensitive === true;
    return {
      key: entry.name,
      value: sensitive ? "" : (storedEnv[entry.name] ?? ""),
      sensitive,
      configured: entry.name in storedEnv,
      description: entry.description,
    };
  });
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
async function buildSkillsWithStatus(slug: InstanceSlug, instanceId: InstanceUuid) {
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

@Controller("api/instances")
export class InstanceSkillsController {
  @RequirePermission(Permission.SKILL_INSTANCE_READ)
  @Get(":slug/skills")
  async getSkills(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const skills = await buildSkillsWithStatus(asInstanceSlug(slug), instance.id);
    return { skills };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Patch(":slug/skills")
  async updateSkills(
    @Param("slug") slug: string,
    @Body() rawBody: unknown,
  ) {
    const { enabled } = parseBody(UpdateSkillsSchema, rawBody);
    const instance = await findInstanceOrFail(slug);
    const enabledSet = new Set(enabled);

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

    const skills = await buildSkillsWithStatus(asInstanceSlug(slug), instance.id);
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
    @Body() rawBody: unknown,
  ) {
    const { autoLoad } = parseBody(AutoLoadSchema, rawBody);
    const instance = await findInstanceOrFail(slug);
    const { setAutoLoad } = await import("../../instances/instance-skills.store.js");
    await setAutoLoad(instance.id, skillSlug, autoLoad);
    return { autoLoad };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Post(":slug/skills/:skillSlug/rollback")
  async rollback(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
    @Body() rawBody: unknown,
  ) {
    const { versionId } = parseBody(RollbackSchema, rawBody);
    const instance = await findInstanceOrFail(slug);
    await rollbackSkill(instance.id, skillSlug, versionId);
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
    const storedEnv = await getSkillEnv(asInstanceSlug(slug), skillSlug);

    return { env: envStatus(requiredEnv, storedEnv) };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Put(":slug/skills/:skillSlug/env")
  async setSkillEnvVars(
    @Param("slug") slug: string,
    @Param("skillSlug") skillSlug: string,
    @Body() rawBody: unknown,
  ) {
    const body = parseBody(SetSkillEnvSchema, rawBody);
    const instance = await findInstanceOrFail(slug);
    const skill = await getSkillFromStore(skillSlug);
    if (!skill) throw new NotFoundException(`Skill "${skillSlug}" not found`);
    const meta = skill.currentVersion?.metadata as { requiredEnv?: RequiredEnvEntry[] } | null;
    const requiredEnv = meta?.requiredEnv ?? [];

    // Only the keys the skill declares, checked before anything is written. A
    // key the skill declares sensitive is encrypted whatever the client says.
    const declared = new Map(requiredEnv.map((e) => [e.name, e]));
    const undeclared = body.env.find((entry) => !declared.has(entry.key));
    if (undeclared) {
      throw new BadRequestException(`env: skill "${skillSlug}" declares no key "${undeclared.key}"`);
    }
    for (const entry of body.env) {
      const sensitive = entry.sensitive || declared.get(entry.key)?.sensitive === true;
      if (entry.value === "" && sensitive) continue;
      await setSkillEnv({
        instanceId: instance.id,
        skillSlug,
        key: entry.key,
        value: entry.value,
        sensitive,
      });
    }

    const storedEnv = await getSkillEnv(asInstanceSlug(slug), skillSlug);

    return { env: envStatus(requiredEnv, storedEnv) };
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
