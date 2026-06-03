// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { registerTool } from "./registry.js";
import { getSkillEnv } from "../../instances/skill-env.store.js";
import { db } from "../../database/client.js";
import { instanceSkills } from "../../instances/instance-skills.schema.js";
import { skills, skillVersions } from "../../skills/schema.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";

registerTool({
  name: "readSkill",
  description:
    "Read the full content of a skill.\n" +
    "Use to load a skill's instructions before applying them. Pass the value of the <name> tag from the <available_skills> section of the prompt.\n" +
    "Returns markdown content, version, and any environment variables for the skill.",
  category: "skills",
  create: (ctx) => ({
    parameters: z.object({
      name: z
        .string()
        .nullable()
        .describe("Name of the skill to load (value of the <name> tag in the <available_skills> section, e.g. 'booking', 'intro-request')"),
    }),
    execute: async ({ name }: { name: string | null }) => {
      const identifier = (name ?? "").trim();
      if (!identifier) {
        return { found: false, error: "Missing required parameter 'name'." };
      }
      const instanceId = await resolveInstanceId(ctx.instanceId);
      if (!instanceId) {
        return { found: false, error: "Instance not found" };
      }

      // Query instance_skills JOIN skills JOIN skill_versions for this instance.
      // Internally the identifier is stored in skills.slug; the tool exposes it as `name`.
      const [row] = await db
        .select({
          enabled: instanceSkills.enabled,
          content: skillVersions.content,
          version: skillVersions.version,
        })
        .from(instanceSkills)
        .innerJoin(skills, eq(instanceSkills.skillId, skills.id))
        .innerJoin(skillVersions, eq(instanceSkills.skillVersionId, skillVersions.id))
        .where(
          and(
            eq(instanceSkills.instanceId, instanceId),
            eq(skills.slug, identifier),
          ),
        )
        .limit(1);

      if (!row || !row.enabled) {
        ctx.audit.log({
          action: "skill.read",
          details: { name: identifier, found: false },
          success: true,
        });
        return { found: false };
      }

      let finalContent = row.content;

      // Inject skill env vars
      const envVars = await getSkillEnv(ctx.instanceId, identifier);
      if (Object.keys(envVars).length > 0) {
        const envBlock = Object.entries(envVars)
          .map(([k, value]) => `  <var name="${k}">${value}</var>`)
          .join("\n");
        finalContent += `\n\n<skill_env>\n${envBlock}\n</skill_env>`;
      }

      ctx.audit.log({
        action: "skill.read",
        details: { name: identifier, found: true },
        success: true,
      });
      return {
        found: true,
        name: identifier,
        version: row.version,
        content: finalContent,
      };
    },
  }),
});
