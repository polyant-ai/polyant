// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import {
  getInstanceSkills,
  enableSkill,
  disableSkill,
} from "../instances/instance-skills.store.js";
import { findInstanceBySlug } from "../instances/store.js";
import { asAgentSlug } from "../instances/identifiers.js";
import { errMsg } from "../utils/error.js";

@Controller(["api/agents/:slug/skills", "api/instances/:slug/skills"])
export class InstanceSkillsController {
  @Get()
  async list(@Param("slug") slug: string) {
    const instance = await findInstanceBySlug(asAgentSlug(slug));
    if (!instance) throw new NotFoundException(`Agent "${slug}" not found`);
    const skills = await getInstanceSkills(instance.id);
    return { skills };
  }

  @Post(":name")
  async enable(@Param("slug") slug: string, @Param("name") name: string) {
    const instance = await findInstanceBySlug(asAgentSlug(slug));
    if (!instance) throw new NotFoundException(`Agent "${slug}" not found`);
    try {
      await enableSkill(instance.id, name);
      return { enabled: true, name };
    } catch (err) {
      const message = errMsg(err);
      if (message.includes("not found")) throw new NotFoundException(message);
      throw new InternalServerErrorException(message);
    }
  }

  @Delete(":name")
  async disable(@Param("slug") slug: string, @Param("name") name: string) {
    const instance = await findInstanceBySlug(asAgentSlug(slug));
    if (!instance) throw new NotFoundException(`Agent "${slug}" not found`);
    await disableSkill(instance.id, name);
    return { disabled: true, name };
  }
}
