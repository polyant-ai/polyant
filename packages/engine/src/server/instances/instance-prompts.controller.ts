// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Patch, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { getPrompts, getPromptSection, upsertPrompt, invalidatePromptsCache } from "../../instances/prompts.store.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { RequirePermission, Permission } from "../../authz/index.js";

const PromptSectionKeys = z.enum([
  "01-identity",
  "02-soul",
  "03-tooling",
  "04-safety",
  "05-skills",
  "06-memory",
  "07-user-identity",
  "08-datetime",
]);

const PatchPromptsSchema = z.object({
  sections: z
    .array(
      z.object({
        key: PromptSectionKeys,
        content: z.string().max(32_768),
      }),
    )
    .min(1)
    .max(8),
});

@Controller("api/agents")
export class InstancePromptsController {
  @RequirePermission(Permission.PROMPT_READ)
  @Get(":slug/prompts")
  async getPrompts(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const rows = await getPrompts(instance.id);
    const prompts = rows.map((r) => ({
      key: r.sectionKey,
      filename: `${r.sectionKey}.md`,
      title: r.title,
      content: r.content,
    }));
    return { prompts };
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

    for (const section of parsed.data.sections) {
      // Preserve existing title if the section already exists
      const existing = await getPromptSection(instance.id, section.key);
      const title = existing?.title ?? section.key;
      await upsertPrompt(instance.id, section.key, title, section.content);
    }

    // Invalidate cache after batch update
    invalidatePromptsCache(instance.id);

    const rows = await getPrompts(instance.id);
    const prompts = rows.map((r) => ({
      key: r.sectionKey,
      filename: `${r.sectionKey}.md`,
      title: r.title,
      content: r.content,
    }));
    return { prompts };
  }
}
