// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Import service — creates/overwrites instances from exported bundles
// ---------------------------------------------------------------------------

import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "./schema.js";
import { resolveWorkspaceIdForPrincipal } from "./store.js";
import { instancePrompts } from "./prompts.schema.js";
import { instanceSkills } from "./instance-skills.schema.js";
import { instanceTools } from "./instance-tools.schema.js";
import { instanceChannels } from "./channels.schema.js";
import { channelConfigSchemas, type ChannelType } from "./channels.store.js";
import { instanceSkillEnv } from "./skill-env.schema.js";
import { skills, skillVersions } from "../skills/schema.js";
import { tools } from "../agents/tools/tools.schema.js";
import { instanceRoom } from "../room/room.schema.js";
import { instanceHooks } from "../hooks/hooks.schema.js";
import { invalidateHooksCache } from "../hooks/hooks.store.js";
import type { HookActionConfig, HookActionType, HookEvent } from "../hooks/hook-types.js";
import { eventSources, eventDefinitions } from "../webhooks/webhooks.schema.js";
import { scheduledTasks } from "../scheduled-tasks/schema.js";
import { computeNextRun } from "../scheduled-tasks/schedule-utils.js";
import { instanceMcpServers } from "./mcp-servers.schema.js";
import { mcpServerConfigSchema, MCP_AUTH_MODES, type McpAuthMode } from "./mcp-servers.store.js";
import { generateToken, encrypt } from "../crypto/index.js";
import { recomputeInstanceTools } from "./instance-tools.store.js";
import { invalidatePromptsCache } from "./prompts.store.js";
import { asInstanceSlug, asInstanceUuid } from "./identifiers.js";
import { invalidateInstanceConfigCache } from "./config-resolver.js";
import {
  instanceBundleSchema,
  type ExportInstanceData,
} from "./export.schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportWarning {
  type: "missing_skill" | "missing_tool" | "secret_required" | "channel_credentials" | "skill_env_required" | "event_source_credentials" | "mcp_server_credentials" | "mcp_server_invalid";
  message: string;
}

export interface ImportResult {
  slug: string;
  instanceId: string;
  warnings: ImportWarning[];
}

// ---------------------------------------------------------------------------
// Import as new instance
// ---------------------------------------------------------------------------

/**
 * Create a brand-new agent from an exported bundle.
 *
 * @param orgId the CALLER's organization (from the request principal), which
 *   decides the owning workspace. It is resolved fail-closed: an unresolvable
 *   organization throws instead of falling back to the deployment default
 *   workspace, which belongs to the seed organization (cross-tenant write).
 */
export async function importNewInstance(
  rawBundle: unknown,
  orgId?: string,
): Promise<ImportResult> {
  const bundle = instanceBundleSchema.parse(rawBundle);
  const data = bundle.instance;
  const warnings: ImportWarning[] = [];

  // Resolve unique slug
  const slug = await resolveUniqueSlug(data.slug);

  // Run everything in a transaction
  const instanceId = await db.transaction(async (tx) => {
    // 1. Create instance in the CALLER's workspace (see store.ts rationale).
    const workspaceId = await resolveWorkspaceIdForPrincipal(orgId, tx);
    const [inst] = await tx
      .insert(instances)
      .values({
        slug,
        name: data.name,
        description: data.description,
        status: data.status,
        provider: data.provider,
        model: data.model,
        memoryEnabled: data.memoryEnabled,
        knowledgeEnabled: data.knowledgeEnabled,
        langsmithEnabled: data.langsmithEnabled,
        langsmithProject: data.langsmithProject,
        authEnabled: data.authEnabled,
        thinkingEnabled: data.thinkingEnabled,
        temperature: data.temperature,
        stateInPromptEnabled: data.stateInPromptEnabled,
        datetimeInjectionEnabled: data.datetimeInjectionEnabled,
        cacheEnabled: data.cacheEnabled,
        cacheTtl: data.cacheTtl,
        toolResultsInHistoryEnabled: data.toolResultsInHistoryEnabled,
        debugEnabled: data.debugEnabled,
        sttProvider: data.sttProvider,
        // Embedding provider/dim only set here (fresh instance — no vectors to
        // lose). Overwrite import intentionally never touches them.
        embeddingProvider: data.embeddingProvider,
        embeddingDim: data.embeddingDim,
        optoutEnabled: data.optoutEnabled,
        optoutStopKeywords: data.optoutStopKeywords,
        optoutResumeKeywords: data.optoutResumeKeywords,
        optoutClosingMessage: data.optoutClosingMessage,
        optoutResumeMessage: data.optoutResumeMessage,
        optoutInjectPromptHint: data.optoutInjectPromptHint,
        icon: data.icon ?? null,
        workspaceId,
      })
      .returning({ id: instances.id });

    const id = asInstanceUuid(inst.id);

    // 2. Import prompts
    await importPrompts(tx, id, data.prompts);

    // 3. Import skill assignments
    const skillWarnings = await importSkillAssignments(tx, id, data.skills);
    warnings.push(...skillWarnings);

    // 4. Import manual tools (after skills, before recompute)
    const toolWarnings = await importManualTools(tx, id, data.manualTools);
    warnings.push(...toolWarnings);

    // 5. Import channels (non-secret config only; credentialed channels stay disabled)
    const channelWarnings = await importChannels(tx, id, data.channels);
    warnings.push(...channelWarnings);

    // 6. Import skill env vars (non-encrypted only)
    const envWarnings = await importSkillEnv(tx, id, data.skillEnv);
    warnings.push(...envWarnings);

    // 7. Import hooks
    await importHooks(tx, id, data.hooks);

    // 8. Import room config
    if (data.room) {
      await importRoom(tx, id, data.room);
    }

    // 9. Import event sources + definitions
    const esWarnings = await importEventSources(tx, id, data.eventSources);
    warnings.push(...esWarnings);

    // 10. Import scheduled tasks
    // NB: scheduled_tasks.instance_id is the SLUG, not the UUID — see the
    // export service for the rationale.
    if (data.scheduledTasks && data.scheduledTasks.length > 0) {
      await importScheduledTasks(tx, slug, data.scheduledTasks);
    }

    // 11. Import MCP servers (non-secret config only; credentialed servers stay disabled)
    const mcpWarnings = await importMcpServers(tx, id, data.mcpServers);
    warnings.push(...mcpWarnings);

    // 12. Secrets — only generate warnings
    for (const secret of data.secrets) {
      warnings.push({
        type: "secret_required",
        message: `Secret "${secret.key}" needs to be configured`,
      });
    }

    return id;
  });

  // Recompute tools outside transaction (uses its own transaction internally)
  await recomputeInstanceTools(instanceId);
  invalidatePromptsCache(instanceId);
  invalidateHooksCache(asInstanceSlug(slug));

  return { slug, instanceId, warnings };
}

// ---------------------------------------------------------------------------
// Import overwrite existing instance
// ---------------------------------------------------------------------------

export async function importOverwriteInstance(
  targetSlug: string,
  rawBundle: unknown,
): Promise<ImportResult> {
  const bundle = instanceBundleSchema.parse(rawBundle);
  const data = bundle.instance;
  const warnings: ImportWarning[] = [];

  // Verify target exists
  const [existing] = await db
    .select({ id: instances.id })
    .from(instances)
    .where(eq(instances.slug, targetSlug))
    .limit(1);

  if (!existing) throw new Error(`Instance "${targetSlug}" not found`);
  const instanceId = asInstanceUuid(existing.id);

  await db.transaction(async (tx) => {
    // 1. Update instance metadata
    await tx
      .update(instances)
      .set({
        name: data.name,
        description: data.description,
        status: data.status,
        provider: data.provider,
        model: data.model,
        memoryEnabled: data.memoryEnabled,
        knowledgeEnabled: data.knowledgeEnabled,
        langsmithEnabled: data.langsmithEnabled,
        langsmithProject: data.langsmithProject,
        authEnabled: data.authEnabled,
        thinkingEnabled: data.thinkingEnabled,
        temperature: data.temperature,
        stateInPromptEnabled: data.stateInPromptEnabled,
        datetimeInjectionEnabled: data.datetimeInjectionEnabled,
        cacheEnabled: data.cacheEnabled,
        cacheTtl: data.cacheTtl,
        toolResultsInHistoryEnabled: data.toolResultsInHistoryEnabled,
        debugEnabled: data.debugEnabled,
        sttProvider: data.sttProvider,
        optoutEnabled: data.optoutEnabled,
        optoutStopKeywords: data.optoutStopKeywords,
        optoutResumeKeywords: data.optoutResumeKeywords,
        optoutClosingMessage: data.optoutClosingMessage,
        optoutResumeMessage: data.optoutResumeMessage,
        optoutInjectPromptHint: data.optoutInjectPromptHint,
        icon: data.icon ?? null,
        // NB: embeddingProvider/embeddingDim are deliberately NOT updated here —
        // switching an existing instance's embedder wipes all vectors (memories +
        // knowledge). That destructive switch is gated behind `confirmWipe` on
        // PATCH /api/instances/:slug and is out of scope for an import.
        updatedAt: sql`now()`,
      })
      .where(eq(instances.id, instanceId));

    // 2. Replace prompts (upsert by sectionKey)
    await importPrompts(tx, instanceId, data.prompts);

    // 3. Replace skill assignments
    await tx.delete(instanceSkills).where(eq(instanceSkills.instanceId, instanceId));
    const skillWarnings = await importSkillAssignments(tx, instanceId, data.skills);
    warnings.push(...skillWarnings);

    // 4. Delete manual tools (recompute will handle the rest)
    await tx
      .delete(instanceTools)
      .where(
        and(
          eq(instanceTools.instanceId, instanceId),
          eq(instanceTools.source, "manual"),
        ),
      );
    const toolWarnings = await importManualTools(tx, instanceId, data.manualTools);
    warnings.push(...toolWarnings);

    // 5. Replace channels (non-secret config only; credentialed channels stay disabled)
    await tx.delete(instanceChannels).where(eq(instanceChannels.instanceId, instanceId));
    const channelWarnings = await importChannels(tx, instanceId, data.channels);
    warnings.push(...channelWarnings);

    // 6. Replace skill env (non-encrypted only; keep existing encrypted)
    await importSkillEnvOverwrite(tx, instanceId, data.skillEnv);
    const envWarnings = data.skillEnv
      .filter((e) => e.encrypted)
      .map((e) => ({
        type: "skill_env_required" as const,
        message: `Skill env "${e.skillSlug}.${e.key}" (encrypted) needs to be configured`,
      }));
    warnings.push(...envWarnings);

    // 7. Replace hooks
    await tx.delete(instanceHooks).where(eq(instanceHooks.instanceId, instanceId));
    await importHooks(tx, instanceId, data.hooks);

    // 8. Replace room config
    await tx.delete(instanceRoom).where(eq(instanceRoom.instanceId, instanceId));
    if (data.room) {
      await importRoom(tx, instanceId, data.room);
    }

    // 9. Replace event sources + definitions
    await tx.delete(eventSources).where(eq(eventSources.instanceId, instanceId));
    const esWarnings = await importEventSources(tx, instanceId, data.eventSources);
    warnings.push(...esWarnings);

    // 10. Replace scheduled tasks
    // NB: scheduled_tasks.instance_id is the SLUG, not the UUID — see the
    // export service for the rationale.
    await tx.delete(scheduledTasks).where(eq(scheduledTasks.instanceId, targetSlug));
    if (data.scheduledTasks && data.scheduledTasks.length > 0) {
      await importScheduledTasks(tx, targetSlug, data.scheduledTasks);
    }

    // 11. Replace MCP servers (non-secret config only; credentialed servers stay disabled)
    await tx.delete(instanceMcpServers).where(eq(instanceMcpServers.instanceId, instanceId));
    const mcpWarnings = await importMcpServers(tx, instanceId, data.mcpServers);
    warnings.push(...mcpWarnings);

    // 12. Secrets warnings
    for (const secret of data.secrets) {
      warnings.push({
        type: "secret_required",
        message: `Secret "${secret.key}" needs to be configured`,
      });
    }
  });

  await recomputeInstanceTools(instanceId);
  invalidatePromptsCache(instanceId);
  invalidateInstanceConfigCache(asInstanceSlug(targetSlug));
  invalidateHooksCache(asInstanceSlug(targetSlug));

  return { slug: targetSlug, instanceId, warnings };
}

// ---------------------------------------------------------------------------
// Import helpers (run inside transaction)
// ---------------------------------------------------------------------------

type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resolveUniqueSlug(desired: string): Promise<string> {
  const [existing] = await db
    .select({ slug: instances.slug })
    .from(instances)
    .where(eq(instances.slug, desired))
    .limit(1);

  if (!existing) return desired;

  // Append -imported, then -imported-2, etc.
  for (let i = 1; i <= 100; i++) {
    const candidate = i === 1 ? `${desired}-imported` : `${desired}-imported-${i}`;
    const [conflict] = await db
      .select({ slug: instances.slug })
      .from(instances)
      .where(eq(instances.slug, candidate))
      .limit(1);
    if (!conflict) return candidate;
  }

  throw new Error(`Could not resolve unique slug for "${desired}"`);
}

async function importPrompts(
  tx: TxClient,
  instanceId: string,
  prompts: ExportInstanceData["prompts"],
): Promise<void> {
  for (const p of prompts) {
    // Anti-resurrection: the 08-datetime section was removed with the datetime
    // flag; drop it from any legacy bundle so an import can't recreate it.
    if (p.sectionKey === "08-datetime") continue;
    await tx
      .insert(instancePrompts)
      .values({
        instanceId,
        sectionKey: p.sectionKey,
        title: p.title,
        content: p.content,
      })
      .onConflictDoUpdate({
        target: [instancePrompts.instanceId, instancePrompts.sectionKey],
        set: { title: p.title, content: p.content, updatedAt: sql`now()` },
      });
  }
}

async function importSkillAssignments(
  tx: TxClient,
  instanceId: string,
  assignments: ExportInstanceData["skills"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];
  if (assignments.length === 0) return warnings;

  // Batch-resolve skill slugs to IDs + version info
  const slugs = assignments.map((a) => a.skillSlug);
  const skillRows = await tx
    .select({
      id: skills.id,
      slug: skills.slug,
      currentVersionId: skills.currentVersionId,
    })
    .from(skills)
    .where(inArray(skills.slug, slugs));

  const skillMap = new Map(skillRows.map((r) => [r.slug, r]));

  for (const assignment of assignments) {
    const skill = skillMap.get(assignment.skillSlug);
    if (!skill) {
      warnings.push({
        type: "missing_skill",
        message: `Skill "${assignment.skillSlug}" not found — skipped`,
      });
      continue;
    }

    // Try to find the specific pinned version
    const [version] = await tx
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skill.id),
          eq(skillVersions.version, assignment.pinnedVersion),
        ),
      )
      .limit(1);

    // Fall back to current version if pinned version not found
    const versionId = version?.id ?? skill.currentVersionId;
    if (!versionId) {
      warnings.push({
        type: "missing_skill",
        message: `Skill "${assignment.skillSlug}" has no available version — skipped`,
      });
      continue;
    }

    await tx
      .insert(instanceSkills)
      .values({
        instanceId,
        skillId: skill.id,
        skillVersionId: versionId,
        enabled: assignment.enabled,
        autoLoad: assignment.autoLoad,
      })
      .onConflictDoUpdate({
        target: [instanceSkills.instanceId, instanceSkills.skillId],
        set: {
          skillVersionId: versionId,
          enabled: assignment.enabled,
          autoLoad: assignment.autoLoad,
          updatedAt: sql`now()`,
        },
      });
  }

  return warnings;
}

async function importManualTools(
  tx: TxClient,
  instanceId: string,
  toolNames: string[],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];
  if (toolNames.length === 0) return warnings;

  const toolRows = await tx
    .select({ id: tools.id, name: tools.name })
    .from(tools)
    .where(inArray(tools.name, toolNames));

  const foundNames = new Set(toolRows.map((r) => r.name));
  for (const name of toolNames) {
    if (!foundNames.has(name)) {
      warnings.push({
        type: "missing_tool",
        message: `Tool "${name}" not found — skipped`,
      });
    }
  }

  if (toolRows.length > 0) {
    await tx
      .insert(instanceTools)
      .values(
        toolRows.map((t) => ({
          instanceId,
          toolId: t.id,
          source: "manual" as const,
        })),
      )
      .onConflictDoNothing();
  }

  return warnings;
}

async function importChannels(
  tx: TxClient,
  instanceId: string,
  channels: ExportInstanceData["channels"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const ch of channels) {
    const config = ch.config ?? {};
    const schema = channelConfigSchemas[ch.channelType as ChannelType];

    // A channel can be safely (re)enabled on import ONLY if its non-secret
    // config alone satisfies the channel's validation schema — i.e. it needs no
    // credentials (today: the `agent` channel, whose config is empty/passthrough).
    // Credentialed channels (telegram/slack/whatsapp) fail this check because the
    // export stripped their secrets, so they stay disabled until reconfigured.
    const canEnable = schema ? schema.safeParse(config).success : false;
    const enabled = ch.enabled && canEnable;
    const hasConfig = Object.keys(config).length > 0;

    await tx
      .insert(instanceChannels)
      .values({
        instanceId,
        channelType: ch.channelType,
        enabled,
        // Persist the non-secret config (encrypted at rest like any channel
        // config) so the admin only has to fill in the missing credentials.
        config: hasConfig ? encrypt(JSON.stringify(config)) : "",
      })
      .onConflictDoNothing();

    if (ch.enabled && !canEnable) {
      warnings.push({
        type: "channel_credentials",
        message: `Channel "${ch.channelType}" imported disabled — configure credentials to enable`,
      });
    }
  }

  return warnings;
}

/** True if the (already-stripped) config still satisfies its authMode's schema — i.e. needs no secret. */
function canEnableMcpServer(authMode: McpAuthMode, config: Record<string, unknown>): boolean {
  try {
    mcpServerConfigSchema(authMode, config);
    return true;
  } catch {
    return false;
  }
}

// Exported for direct unit testing (mirrors stripSensitiveKeys/exportMcpServers
// in export.service.ts — the store-level insert is simple enough to test with
// a fake `tx`, without mocking the whole database client).
export async function importMcpServers(
  tx: TxClient,
  instanceId: string,
  servers: ExportInstanceData["mcpServers"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const server of servers) {
    const authMode = server.authMode as McpAuthMode;

    // exportMcpServerSchema.authMode is z.string() (export must round-trip
    // whatever a future/foreign version writes), so an unknown value (e.g.
    // "oidc", or garbage) is NOT rejected by the bundle schema. Guard it here:
    // mcpServerConfigSchema falls back to the all-optional oauth schema for
    // any authMode !== "static", so a bogus mode would otherwise validate and
    // insert an ENABLED row the runtime doesn't recognize (no DB CHECK on
    // auth_mode). Skip the server entirely rather than persist garbage —
    // mirrors the per-item degradation used for channels/skills/tools above.
    if (!MCP_AUTH_MODES.includes(authMode)) {
      warnings.push({
        type: "mcp_server_invalid",
        message: `MCP server "${server.slug}" has unknown authMode "${server.authMode}" — skipped`,
      });
      continue;
    }

    const config = server.config ?? {};

    // A server can be safely (re)enabled on import ONLY if its stripped config
    // alone satisfies the auth mode's validation schema — i.e. it needs no
    // secret. A static server fails this (the exporter stripped auth.token),
    // so it stays disabled until the token is reconfigured; an oauth server
    // with no required secret field passes and re-enables as-is.
    const canEnable = canEnableMcpServer(authMode, config);
    const enabled = server.enabled && canEnable;

    await tx
      .insert(instanceMcpServers)
      .values({
        instanceId,
        slug: server.slug,
        name: server.name,
        url: server.url,
        authMode: server.authMode,
        enabled,
        // Persist the non-secret config as-is (encrypted at rest like any MCP
        // server config) so the admin only has to fill in the missing credentials.
        config: encrypt(JSON.stringify(config)),
      })
      .onConflictDoNothing();

    if (server.enabled && !canEnable) {
      warnings.push({
        type: "mcp_server_credentials",
        message: `MCP server "${server.slug}" imported disabled — configure credentials to enable`,
      });
    }
  }

  return warnings;
}

async function importHooks(
  tx: TxClient,
  instanceId: string,
  hooks: ExportInstanceData["hooks"],
): Promise<void> {
  for (const h of hooks) {
    await tx.insert(instanceHooks).values({
      instanceId,
      event: h.event as HookEvent,
      actionType: h.actionType as HookActionType,
      actionConfig: h.actionConfig as unknown as HookActionConfig,
      enabled: h.enabled,
      position: h.position,
      timeoutMs: h.timeoutMs,
    });
  }
}

async function importSkillEnv(
  tx: TxClient,
  instanceId: string,
  envVars: ExportInstanceData["skillEnv"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const env of envVars) {
    if (env.encrypted) {
      warnings.push({
        type: "skill_env_required",
        message: `Skill env "${env.skillSlug}.${env.key}" (encrypted) needs to be configured`,
      });
      continue;
    }

    // Non-encrypted values can be imported directly
    await tx
      .insert(instanceSkillEnv)
      .values({
        instanceId,
        skillSlug: env.skillSlug,
        key: env.key,
        value: env.value ?? "",
        encrypted: false,
      })
      .onConflictDoUpdate({
        target: [instanceSkillEnv.instanceId, instanceSkillEnv.skillSlug, instanceSkillEnv.key],
        set: { value: env.value ?? "", encrypted: false, updatedAt: new Date() },
      });
  }

  return warnings;
}

async function importSkillEnvOverwrite(
  tx: TxClient,
  instanceId: string,
  envVars: ExportInstanceData["skillEnv"],
): Promise<void> {
  // Delete only non-encrypted env vars (keep encrypted ones intact)
  // Then import non-encrypted values from bundle
  const nonEncryptedRows = await tx
    .select({ id: instanceSkillEnv.id })
    .from(instanceSkillEnv)
    .where(
      and(
        eq(instanceSkillEnv.instanceId, instanceId),
        eq(instanceSkillEnv.encrypted, false),
      ),
    );

  if (nonEncryptedRows.length > 0) {
    await tx
      .delete(instanceSkillEnv)
      .where(
        and(
          eq(instanceSkillEnv.instanceId, instanceId),
          eq(instanceSkillEnv.encrypted, false),
        ),
      );
  }

  for (const env of envVars) {
    if (env.encrypted) continue;

    await tx
      .insert(instanceSkillEnv)
      .values({
        instanceId,
        skillSlug: env.skillSlug,
        key: env.key,
        value: env.value ?? "",
        encrypted: false,
      })
      .onConflictDoNothing();
  }
}

async function importRoom(
  tx: TxClient,
  instanceId: string,
  room: NonNullable<ExportInstanceData["room"]>,
): Promise<void> {
  await tx
    .insert(instanceRoom)
    .values({
      instanceId,
      enabled: room.enabled,
      prompt: room.prompt,
      outboundChannel: room.outboundChannel,
      outboundTarget: room.outboundTarget,
      evalIntervalMinutes: room.evalIntervalMinutes,
    })
    .onConflictDoUpdate({
      target: [instanceRoom.instanceId],
      set: {
        enabled: room.enabled,
        prompt: room.prompt,
        outboundChannel: room.outboundChannel,
        outboundTarget: room.outboundTarget,
        evalIntervalMinutes: room.evalIntervalMinutes,
        updatedAt: new Date(),
      },
    });
}

async function importEventSources(
  tx: TxClient,
  instanceId: string,
  sources: ExportInstanceData["eventSources"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const source of sources) {
    const webhookToken = generateToken(32);

    const [created] = await tx
      .insert(eventSources)
      .values({
        instanceId,
        name: source.name,
        sourceType: source.sourceType,
        config: "", // empty — user must configure credentials
        enabled: false, // disabled until configured
        webhookToken,
      })
      .returning({ id: eventSources.id });

    warnings.push({
      type: "event_source_credentials",
      message: `Event source "${source.name}" imported without credentials — configure manually`,
    });

    // Import definitions
    for (const def of source.definitions) {
      await tx.insert(eventDefinitions).values({
        eventSourceId: created.id,
        name: def.name,
        matchingPrompt: def.matchingPrompt,
        interpretationPrompt: def.interpretationPrompt,
        action: def.action,
        contextPrompt: def.contextPrompt,
        outboundChannel: def.outboundChannel,
        outboundTarget: def.outboundTarget,
        enabled: def.enabled,
      });
    }
  }

  return warnings;
}

async function importScheduledTasks(
  tx: TxClient,
  instanceId: string,
  tasks: NonNullable<ExportInstanceData["scheduledTasks"]>,
): Promise<void> {
  for (const task of tasks) {
    const schedule = task.schedule as import("../scheduled-tasks/schema.js").ScheduleConfig;
    const nextRunAt = task.enabled ? computeNextRun(schedule) : null;

    await tx.insert(scheduledTasks).values({
      instanceId,
      name: task.name,
      description: task.description,
      enabled: task.enabled,
      schedule,
      prompt: task.prompt,
      outboundChannel: task.outboundChannel,
      outboundTarget: task.outboundTarget,
      keepHistory: task.keepHistory,
      deleteAfterRun: task.deleteAfterRun,
      maxRetries: task.maxRetries,
      createdBy: task.createdBy,
      nextRunAt,
    });
  }
}
