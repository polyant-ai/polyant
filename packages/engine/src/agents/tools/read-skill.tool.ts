// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { getSkillEnvEntries } from "../../instances/skill-env.store.js";
import { db } from "../../database/client.js";
import { instanceSkills } from "../../instances/instance-skills.schema.js";
import { skills, skillVersions } from "../../skills/schema.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";

export default defineTool({
  name: "readSkill",
  description:
    "Read the full content of a skill.\n" +
    "Use to load a skill's instructions before applying them. Pass the value of the <name> tag from the <available_skills> section of the prompt.\n" +
    "Returns markdown content, version, and any environment variables for the skill.",
  category: "skills",
  parameters: z.object({
    name: z
      .string()
      .nullable()
      .describe("Name of the skill to load (value of the <name> tag in the <available_skills> section, e.g. 'booking', 'intro-request')"),
  }),
  execute: async ({ name }: { name: string | null }, ctx) => {
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

    /*
      Skill env, with the sensitive half kept OUT of the model's context.

      A value the operator marked sensitive is encrypted at rest. Interpolating
      it here put the plaintext in the conversation, in the persisted history and
      — through `safeOutputPreview` — in `tool_audit_logs`, which made the audit
      table a second, cleartext copy of the thing the encryption protects. No
      attack was needed: the prompt tells the model to call this tool.

      So a sensitive var is emitted as an opaque placeholder, which `buildTool`
      resolves between validation and `execute`. The plaintext then exists only
      inside the tool call. Non-sensitive vars are plain settings and stay inline.
    */
    const envVars = await getSkillEnvEntries(ctx.instanceId, identifier);
    if (envVars.length > 0) {
      const envBlock = envVars
        .map(({ key, value, sensitive }) =>
          sensitive
            ? `  <var name="${key}" value="{{skill_env.${identifier}.${key}}}" sensitive />`
            : `  <var name="${key}">${value}</var>`,
        )
        .join("\n");
      const note = envVars.some((v) => v.sensitive)
        ? "\nA `value=\"{{...}}\"` placeholder is a secret you cannot read. Pass it through" +
          " verbatim as a tool argument and it will be resolved; do not try to look it up."
        : "";
      finalContent += `\n\n<skill_env>\n${envBlock}\n</skill_env>${note}`;
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
});
