// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Import service — creates/overwrites instances from exported bundles.
//
// This file is the public face: the two orchestrators below, plus
// re-exports of the per-domain importers other modules reach for directly
// (`importChannels`, `importMcpServers` — unit-tested against a fake `tx`).
// Each domain's actual import logic lives in its own `{entity}.import.ts`
// file next to this one (see report for the split rationale).
// ---------------------------------------------------------------------------

import { eq, and, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "./schema.js";
import { resolveWorkspaceIdForPrincipal } from "./store.js";
import { instanceSkills } from "./instance-skills.schema.js";
import { instanceTools } from "./instance-tools.schema.js";
import { instanceChannels } from "./channels.schema.js";
import { instanceRoom } from "../room/room.schema.js";
import { instanceHooks } from "../hooks/hooks.schema.js";
import { invalidateHooksCache } from "../hooks/hooks.store.js";
import { eventSources } from "../webhooks/webhooks.schema.js";
import { scheduledTasks } from "../scheduled-tasks/schema.js";
import { instanceMcpServers } from "./mcp-servers.schema.js";
import { recomputeInstanceTools } from "./instance-tools.store.js";
import { invalidatePromptsCache } from "./prompts.store.js";
import { asInstanceSlug, asInstanceUuid } from "./identifiers.js";
import { invalidateInstanceConfigCache } from "./config-resolver.js";
import { instanceBundleSchema } from "./export.schema.js";
import { importPrompts } from "./prompts.import.js";
import { importSkillAssignments } from "./skill-assignments.import.js";
import { importManualTools } from "./manual-tools.import.js";
import { importChannels } from "./channels.import.js";
import { importSkillEnv, importSkillEnvOverwrite } from "./skill-env.import.js";
import { importHooks } from "./hooks.import.js";
import { importRoom } from "./room.import.js";
import { importEventSources } from "./event-sources.import.js";
import { importScheduledTasks } from "./scheduled-tasks.import.js";
import { importMcpServers } from "./mcp-servers.import.js";
import type { ImportWarning, ImportResult } from "./import.types.js";

export type { ImportWarning, ImportResult } from "./import.types.js";
export { importChannels, importMcpServers };

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
        a2aEnabled: data.a2aEnabled,
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
        a2aEnabled: data.a2aEnabled,
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
// Import helpers
// ---------------------------------------------------------------------------

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
