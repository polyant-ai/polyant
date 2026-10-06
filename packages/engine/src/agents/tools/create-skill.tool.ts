// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import { createSkill } from "../../skills/skills.store.js";
import { enableSkill } from "../../instances/instance-skills.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import type { InstanceSlug } from "../../instances/identifiers.js";

interface CreatedSkill {
  id: string;
  slug: string;
  name: string;
}

/**
 * The skill row was committed but enabling it on the agent failed. Carries the
 * skill so the result says `created: true`: the skill exists, and reporting a
 * failure would invite the model to create it again under another name.
 */
class SkillCreatedButNotEnabledError extends Error {
  constructor(public readonly skill: CreatedSkill, cause: unknown) {
    super(errMsg(cause));
  }
}

/**
 * Create the skill in the library, then enable it on the calling agent.
 *
 * The agent is always the caller's own (`ctx.instanceId`), never a value the
 * model supplies. Creation and enabling are two commits: `createSkill` commits
 * its own transaction, so a failure while enabling leaves a real skill that is
 * simply not enabled yet, which the result reports as such.
 */
async function createAndEnableSkill(
  instanceSlug: InstanceSlug,
  input: { slug: string; description: string; content: string; requiredEnv: string[] | null },
): Promise<CreatedSkill> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) throw new Error(`Agent "${instanceSlug}" not found`);

  const requiredEnv = input.requiredEnv?.map((e) => e.trim()).filter(Boolean) ?? [];
  const skill = await createSkill({
    slug: input.slug,
    name: input.slug,
    description: input.description,
    content: input.content,
    metadata: {
      name: input.slug,
      description: input.description,
      version: "0.1.0",
      category: "general",
      requiredTools: [],
      requiredEnv,
      scripts: [],
    },
  });

  try {
    await enableSkill(instanceId, skill.slug);
  } catch (err) {
    throw new SkillCreatedButNotEnabledError(skill, err);
  }
  return skill;
}

export default defineTool({
  name: "createSkill",
  description:
    "Create a new skill (a reusable set of instructions) and enable it for this agent.\n" +
    "Use when the user wants to teach you a new way of handling a specific kind of request.\n" +
    "Do NOT use to read an existing skill — use readSkill.\n" +
    "Returns the name of the created skill.\n" +
    "Caveat: the name is turned into a slug (lowercase, hyphens). requiredEnv is optional; when set, the skill is not shown until those variables are configured.",
  category: "skills",
  inputExamples: [
    {
      label: "Create an FAQ handling skill",
      input: {
        name: "faq-handler",
        description: "Answers frequently asked questions",
        content: "# FAQ handler\n\nWhen the user asks about...",
        requiredEnv: null,
      },
    },
  ],
  parameters: z.object({
    name: z.string().describe("Skill name, used as its slug (no spaces)"),
    description: z.string().describe("Short description of the skill"),
    content: z.string().describe("The skill's full instructions, in markdown"),
    requiredEnv: z
      .array(z.string())
      .nullable()
      .describe(
        "Environment variables the skill needs (e.g. ['NOTION_API_KEY']). " +
          "The skill is not shown until they are configured. Pass null when none are needed.",
      ),
  }),
  execute: async (
    {
      name,
      description,
      content,
      requiredEnv,
    }: { name: string; description: string; content: string; requiredEnv: string[] | null },
    ctx,
  ) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    try {
      const skill = await createAndEnableSkill(ctx.instanceId, { slug, description, content, requiredEnv });
      ctx.audit.log({ action: "skill.create", details: { name: skill.name, slug: skill.slug }, success: true });
      return { created: true, name: skill.slug };
    } catch (err) {
      const skill = err instanceof SkillCreatedButNotEnabledError ? err.skill : undefined;
      const message = errMsg(err);
      console.error(`createSkill error: ${message}`);
      ctx.audit.log({
        action: "skill.create",
        details: { name, slug, skillId: skill?.id },
        success: false,
        error: message,
      });
      return skill ? { created: true, name: skill.slug, error: message } : { created: false, error: message };
    }
  },
});
