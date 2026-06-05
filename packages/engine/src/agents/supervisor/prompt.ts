// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Tool } from "ai";
import { eq, and } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../database/client.js";
import { getPrompts, invalidatePromptsCache } from "../../instances/prompts.store.js";
import { instanceSkills } from "../../instances/instance-skills.schema.js";
import { skills, skillVersions } from "../../skills/schema.js";
import { hasAllRequiredEnvBatch } from "../../instances/skill-env.store.js";
import { normalizeRequiredEnv } from "../../utils/frontmatter.js";
import { type InstanceSlug, type InstanceUuid } from "../../instances/identifiers.js";

export { normalizeRequiredEnv, type RequiredEnvEntry } from "../../utils/frontmatter.js";

// Re-export DB-backed cache invalidation for external callers
export { invalidatePromptsCache };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptOptions {
  tools?: Record<string, Tool>;
  instanceId: InstanceUuid;
  /** Instance slug — needed for skill env checks (resolveInstanceId inside). */
  instanceSlug: InstanceSlug;
  memoryEnabled?: boolean;
  knowledgeEnabled?: boolean;
  conversationSummary?: string;
  /** Additional context prompt injected from webhook triggers. Persisted per-conversation. */
  contextPrompt?: string;
  /**
   * Identity of the counterpart this conversation is with. When provided, a
   * `## Current channel` section is injected into the system prompt so the
   * agent always knows who it is talking to across channels.
   */
  channelIdentity?: {
    channel: string;
    channelId: string;
    userName?: string;
  };
}

/**
 * Render the `## Current channel` section: an explicit, channel-agnostic
 * block that exposes channel type, channel id, and (when available) the
 * user's display name. Integration-specific guidance (e.g. how to resolve
 * the matching contact in an external system for each channel) belongs in
 * the per-instance prompt or in a skill — not here — so the framework
 * stays generic.
 */
function renderChannelIdentitySection(
  identity: NonNullable<PromptOptions["channelIdentity"]>,
): string {
  const channel = identity.channel.toLowerCase();
  const lines = [
    `## Current channel`,
    ``,
    `You are talking via ${channel}.`,
    `- Channel ID: ${identity.channelId}`,
    `- User name: ${identity.userName ?? "unknown"}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return Object.entries(vars).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  );
}

function generateToolCatalog(tools: Record<string, Tool>): string {
  return Object.entries(tools)
    .map(
      ([name, t]) =>
        `- **${name}**: ${(t as { description?: string }).description ?? ""}`,
    )
    .join("\n");
}


// ---------------------------------------------------------------------------
// Skill discovery (from DB — replaces filesystem iteration)
// ---------------------------------------------------------------------------

interface SkillEntry {
  name: string;
  description: string;
  slug: string;
  autoLoadContent?: string;
}

interface SkillVersionMetadata {
  name?: string;
  description?: string;
  requiredEnv?: unknown[];
  requiredTools?: string[];
}

/**
 * Discover enabled skills for an instance from the database.
 * Fetches pinned version content/metadata, checks requiredEnv, and filters.
 */
async function discoverSkills(
  instanceId: InstanceUuid,
  instanceSlug: InstanceSlug,
  enabledToolNames?: Set<string>,
): Promise<SkillEntry[]> {
  // Single query: get enabled skills with their pinned version data
  const rows = await db
    .select({
      skillSlug: skills.slug,
      skillName: skills.name,
      skillDescription: skills.description,
      versionContent: skillVersions.content,
      versionMetadata: skillVersions.metadata,
      autoLoad: instanceSkills.autoLoad,
    })
    .from(instanceSkills)
    .innerJoin(skills, eq(instanceSkills.skillId, skills.id))
    .innerJoin(skillVersions, eq(instanceSkills.skillVersionId, skillVersions.id))
    .where(
      and(
        eq(instanceSkills.instanceId, instanceId),
        eq(instanceSkills.enabled, true),
        eq(skills.status, "active"),
      ),
    );

  if (rows.length === 0) return [];

  // Collect env-check requirements for batch query
  const envChecks: Array<{ skillSlug: string; keys: string[] }> = [];
  const parsed = rows.map((row) => {
    const meta = row.versionMetadata as SkillVersionMetadata | null;
    const envEntries = meta?.requiredEnv ? normalizeRequiredEnv(meta.requiredEnv) : [];
    if (envEntries.length > 0) {
      envChecks.push({ skillSlug: row.skillSlug, keys: envEntries.map((e) => e.name) });
    }
    return { row, meta, envEntries };
  });

  // Single batch query for all skill env checks
  const envResults = envChecks.length > 0
    ? await hasAllRequiredEnvBatch(instanceSlug, envChecks)
    : new Map<string, boolean>();

  const result: SkillEntry[] = [];

  for (const { row, meta, envEntries } of parsed) {
    // Skip if required env vars are not configured
    if (envEntries.length > 0 && !envResults.get(row.skillSlug)) continue;

    // Skip if required tools are not available
    if (meta?.requiredTools && enabledToolNames) {
      const missingTools = meta.requiredTools.filter((t) => !enabledToolNames.has(t));
      if (missingTools.length > 0) continue;
    }

    result.push({
      name: meta?.name ?? row.skillName,
      description: meta?.description ?? row.skillDescription,
      slug: row.skillSlug,
      autoLoadContent: row.autoLoad ? (row.versionContent ?? undefined) : undefined,
    });
  }

  return result;
}

async function loadSkillsList(
  instanceId: InstanceUuid,
  instanceSlug: InstanceSlug,
  enabledToolNames?: Set<string>,
): Promise<string> {
  const skillEntries = await discoverSkills(instanceId, instanceSlug, enabledToolNames);
  if (skillEntries.length === 0)
    return "<available_skills>\n  <!-- No skills available -->\n</available_skills>";
  const entries = skillEntries
    .map((s) => {
      if (s.autoLoadContent) {
        return `  <skill autoLoaded="true">\n    <name>${s.slug}</name>\n    <description>${s.description}</description>\n    <content>\n${s.autoLoadContent}\n    </content>\n  </skill>`;
      }
      return `  <skill>\n    <name>${s.slug}</name>\n    <description>${s.description}</description>\n  </skill>`;
    })
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export async function buildSupervisorSystemPrompt(options: PromptOptions): Promise<string> {
  const { instanceId, instanceSlug } = options;

  const datetime = new Date().toLocaleString(config.datetime.locale, {
    timeZone: config.datetime.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });

  // Fetch all prompt sections from DB in one call (cached at 60s)
  const promptRows = await getPrompts(instanceId);
  const sectionMap = new Map(promptRows.map((r) => [r.sectionKey, r.content]));

  // Helper: get section content by key (empty string if missing)
  const section = (key: string) => sectionMap.get(key)?.trim() ?? "";

  // Collect enabled tool names for skill requiredTools check
  const enabledToolNames = options.tools
    ? new Set(Object.keys(options.tools))
    : undefined;

  // 1. Identity (static)
  const s01 = section("01-identity");

  // 2. Soul
  const s02 = section("02-soul");

  // 3. Tooling (template)
  const toolCatalog = options.tools
    ? generateToolCatalog(options.tools)
    : "No tools available.";
  const s03 = applyTemplate(section("03-tooling"), { toolCatalog });

  // 4. Safety (static)
  const s04 = section("04-safety");

  // 5. Skills (template)
  const s05 = applyTemplate(section("05-skills"), {
    skillsList: await loadSkillsList(instanceId, instanceSlug, enabledToolNames),
  });

  // 6. Memory (skipped when memory is disabled)
  const s06 = options.memoryEnabled !== false ? section("06-memory") : "";

  // 7. User Identity
  const s07 = section("07-user-identity");

  // 8. Datetime (template)
  const s08 = applyTemplate(section("08-datetime"), {
    datetime,
    timezone: config.datetime.timezone,
  });

  const sections = [s01, s02, s03, s04, s05, s06, s07, s08];

  if (options.channelIdentity) {
    sections.push(renderChannelIdentitySection(options.channelIdentity));
  }

  if (options.contextPrompt) {
    sections.push(
      `## Conversation Context\n\n${options.contextPrompt}`,
    );
  }

  if (options.conversationSummary) {
    sections.push(
      `## Previous conversation context (summary)\n\n${options.conversationSummary}\n\nNote: this is a summary of earlier messages. When tool results from the current turn contain data (dates, names, figures), always use the current tool results — they take precedence over this summary.`,
    );
  }

  return sections
    .filter(Boolean)
    .join("\n\n---\n\n");
}
