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
  upgradeSkill,
  rollbackSkill,
  getPinnedSkillMetadata,
  getAgentSkillContent,
} from "../../instances/instance-skills.store.js";
import { getSkill as getSkillFromStore } from "../../skills/skills.store.js";
import { setSkillEnv, getSkillEnv, deleteSkillEnv } from "../../instances/skill-env.store.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { asInstanceSlug, type InstanceUuid } from "../../instances/identifiers.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { parseBody } from "../utils/parse-body.js";
import {
  listAgentSkills,
  setAgentSkillAutoLoad,
  setEnabledAgentSkills,
  type RequiredEnvEntry,
} from "../../instances/agent-skills.js";

/** The complete list of skills the agent keeps. Required: a missing list would read as "none". */
const UpdateSkillsSchema = z.object({ enabled: z.array(z.string()) });
const AutoLoadSchema = z.object({ autoLoad: z.boolean() });
const RollbackSchema = z.object({ versionId: z.string().min(1) });
/** `sensitive` is required: without it a secret would be stored in clear. */
const SetSkillEnvSchema = z.object({
  env: z.array(z.object({ key: z.string().min(1), value: z.string(), sensitive: z.boolean() })),
});

const requiredEnvOf = (metadata: unknown): RequiredEnvEntry[] =>
  (metadata as { requiredEnv?: RequiredEnvEntry[] } | null)?.requiredEnv ?? [];

/**
 * The keys an agent may set for a skill: the ones the version it is pinned to
 * reads, which its turns run, and the ones the skill's current version reads, so
 * an upgrade finds them set. A key either declares sensitive is sensitive.
 */
async function declaredSkillEnv(
  instanceId: InstanceUuid,
  skill: { slug: string; currentVersion?: { metadata: unknown } | null },
): Promise<RequiredEnvEntry[]> {
  const declared = new Map<string, RequiredEnvEntry>();
  const pinned = requiredEnvOf(await getPinnedSkillMetadata(instanceId, skill.slug));
  for (const entry of [...pinned, ...requiredEnvOf(skill.currentVersion?.metadata)]) {
    const seen = declared.get(entry.name);
    declared.set(entry.name, seen ? { ...seen, sensitive: seen.sensitive === true || entry.sensitive === true } : entry);
  }
  return [...declared.values()];
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

@Controller("api/instances")
export class InstanceSkillsController {
  @RequirePermission(Permission.SKILL_INSTANCE_READ)
  @Get(":slug/skills")
  async getSkills(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const skills = await listAgentSkills(asInstanceSlug(slug), instance.id);
    return { skills };
  }

  /**
   * One of the agent's skills, read for its drawer: the text of the version the agent
   * runs. Answers `agent.skill:read`, the permission the list answers; a skill the
   * list does not show is a 404.
   */
  @RequirePermission(Permission.SKILL_INSTANCE_READ)
  @Get(":slug/skills/:skillSlug")
  async getSkill(@Param("slug") slug: string, @Param("skillSlug") skillSlug: string) {
    const instance = await findInstanceOrFail(slug);
    const skill = await getAgentSkillContent(instance.id, skillSlug);
    if (!skill) throw new NotFoundException(`Skill "${skillSlug}" not found`);
    return { name: skillSlug, ...skill };
  }

  @RequirePermission(Permission.SKILL_INSTANCE_WRITE)
  @Patch(":slug/skills")
  async updateSkills(
    @Param("slug") slug: string,
    @Body() rawBody: unknown,
  ) {
    const { enabled } = parseBody(UpdateSkillsSchema, rawBody);
    const instance = await findInstanceOrFail(slug);
    return setEnabledAgentSkills(asInstanceSlug(slug), instance.id, enabled);
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
    await setAgentSkillAutoLoad(instance.id, skillSlug, autoLoad);
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
    const instance = await findInstanceOrFail(slug);
    const skill = await getSkillFromStore(skillSlug);
    if (!skill) throw new NotFoundException(`Skill "${skillSlug}" not found`);

    const requiredEnv = await declaredSkillEnv(instance.id, skill);
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
    const requiredEnv = await declaredSkillEnv(instance.id, skill);

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
