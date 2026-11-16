// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Patch, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import {
  PROMPT_SECTION_KEYS,
  PROMPT_SECTION_MAX_CHARS,
  readAgentPrompt,
  writeAgentPrompt,
} from "../../instances/agent-prompts.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { RequirePermission, Permission } from "../../authz/index.js";

const PromptSectionKeys = z.enum(PROMPT_SECTION_KEYS);

const PatchPromptsSchema = z.object({
  sections: z
    .array(
      z.object({
        key: PromptSectionKeys,
        content: z.string().max(PROMPT_SECTION_MAX_CHARS),
      }),
    )
    .min(1)
    .max(7),
});

@Controller("api/instances")
export class InstancePromptsController {
  @RequirePermission(Permission.PROMPT_READ)
  @Get(":slug/prompts")
  async getPrompts(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    return { prompts: await readAgentPrompt(instance.id) };
  }

  @RequirePermission(Permission.PROMPT_WRITE)
  @Patch(":slug/prompts")
  async updatePrompts(
    @Param("slug") slug: string,
    @Body() body: unknown,
  ) {
    const parsed = PatchPromptsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }

    const instance = await findInstanceOrFail(slug);

    return { prompts: await writeAgentPrompt(instance.id, parsed.data.sections) };
  }
}
