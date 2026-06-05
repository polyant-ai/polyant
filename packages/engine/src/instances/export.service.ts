// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Export service — assembles instance bundles from all stores
// ---------------------------------------------------------------------------

import { eq, and } from "drizzle-orm";
import { db } from "../database/client.js";
import { findInstanceBySlug, type Instance } from "./store.js";
import { asInstanceSlug, type InstanceUuid } from "./identifiers.js";
import { getPrompts } from "./prompts.store.js";
import { getInstanceSkills } from "./instance-skills.store.js";
import { instanceTools } from "./instance-tools.schema.js";
import { tools } from "../agents/tools/tools.schema.js";
import { instanceSecrets } from "./secrets.schema.js";
import { instanceChannels } from "./channels.schema.js";
import { instanceSkillEnv } from "./skill-env.schema.js";
import { getRoomByInstanceId } from "../room/room.store.js";
import { listEventSourcesWithDefinitions } from "../webhooks/webhook-sources.store.js";
import { listByInstance as listScheduledTasks } from "../scheduled-tasks/store.js";
import type { InstanceBundle, ExportInstanceData } from "./export.schema.js";

// ---------------------------------------------------------------------------
// Export instance
// ---------------------------------------------------------------------------

export async function exportInstance(slug: string): Promise<InstanceBundle> {
  const instance = await findInstanceBySlug(asInstanceSlug(slug));
  if (!instance) throw new Error(`Instance "${slug}" not found`);

  const data = await assembleInstanceData(instance);

  return {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    type: "instance",
    instance: data,
  };
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

async function assembleInstanceData(instance: Instance): Promise<ExportInstanceData> {
  // Parallel reads — all independent queries
  const [
    prompts,
    skillAssignments,
    manualToolNames,
    secretKeys,
    channels,
    skillEnvRows,
    roomConfig,
    eventSourcesWithDefs,
    tasks,
  ] = await Promise.all([
    exportPrompts(instance.id),
    exportSkillAssignments(instance.id),
    exportManualTools(instance.id),
    exportSecretKeys(instance.id),
    exportChannels(instance.id),
    exportSkillEnv(instance.id),
    getRoomByInstanceId(instance.id),
    listEventSourcesWithDefinitions(instance.slug),
    // scheduled_tasks.instance_id is stored as the SLUG (text column, not
    // a UUID FK) — every other caller in the system (controller, scheduler,
    // schedule-task tool) reads/writes it as the slug. The export must
    // match or it would always return an empty array.
    listScheduledTasks(instance.slug),
  ]);

  return {
    slug: instance.slug,
    name: instance.name,
    description: instance.description,
    status: instance.status,
    provider: instance.provider,
    model: instance.model,
    memoryEnabled: instance.memoryEnabled,
    knowledgeEnabled: instance.knowledgeEnabled,
    langsmithEnabled: instance.langsmithEnabled,
    authEnabled: instance.authEnabled,
    icon: instance.icon,
    prompts,
    skills: skillAssignments,
    manualTools: manualToolNames,
    secrets: secretKeys,
    channels,
    skillEnv: skillEnvRows,
    room: roomConfig
      ? {
          enabled: roomConfig.enabled,
          prompt: roomConfig.prompt,
          outboundChannel: roomConfig.outboundChannel,
          outboundTarget: roomConfig.outboundTarget,
          evalIntervalMinutes: roomConfig.evalIntervalMinutes,
        }
      : null,
    eventSources: eventSourcesWithDefs.map((es) => ({
      name: es.name,
      sourceType: es.sourceType,
      enabled: es.enabled,
      definitions: es.definitions.map((d) => ({
        name: d.name,
        matchingPrompt: d.matchingPrompt,
        interpretationPrompt: d.interpretationPrompt,
        enabled: d.enabled,
      })),
    })),
    scheduledTasks: tasks.map((t) => ({
      name: t.name,
      description: t.description ?? null,
      enabled: t.enabled,
      schedule: t.schedule,
      prompt: t.prompt,
      outboundChannel: t.outboundChannel ?? null,
      outboundTarget: t.outboundTarget ?? null,
      keepHistory: t.keepHistory,
      deleteAfterRun: t.deleteAfterRun,
      maxRetries: t.maxRetries,
      createdBy: t.createdBy ?? null,
    })),
  };
}

async function exportPrompts(instanceId: InstanceUuid) {
  const rows = await getPrompts(instanceId);
  return rows.map((r) => ({
    sectionKey: r.sectionKey,
    title: r.title,
    content: r.content,
  }));
}

async function exportSkillAssignments(instanceId: InstanceUuid) {
  const rows = await getInstanceSkills(instanceId);
  return rows.map((r) => ({
    skillSlug: r.skillSlug,
    enabled: r.enabled,
    autoLoad: r.autoLoad,
    pinnedVersion: r.pinnedVersion,
  }));
}

async function exportManualTools(instanceId: string): Promise<string[]> {
  const rows = await db
    .select({ name: tools.name })
    .from(instanceTools)
    .innerJoin(tools, eq(instanceTools.toolId, tools.id))
    .where(
      and(
        eq(instanceTools.instanceId, instanceId),
        eq(instanceTools.source, "manual"),
      ),
    );
  return rows.map((r) => r.name);
}

async function exportSecretKeys(instanceId: string) {
  const rows = await db
    .select({ key: instanceSecrets.key })
    .from(instanceSecrets)
    .where(eq(instanceSecrets.instanceId, instanceId));
  return rows.map((r) => ({ key: r.key, configured: true }));
}

async function exportChannels(instanceId: string) {
  const rows = await db
    .select({
      channelType: instanceChannels.channelType,
      enabled: instanceChannels.enabled,
    })
    .from(instanceChannels)
    .where(eq(instanceChannels.instanceId, instanceId));
  return rows.map((r) => ({
    channelType: r.channelType,
    enabled: r.enabled,
  }));
}

async function exportSkillEnv(instanceId: string) {
  const rows = await db
    .select({
      skillSlug: instanceSkillEnv.skillSlug,
      key: instanceSkillEnv.key,
      value: instanceSkillEnv.value,
      encrypted: instanceSkillEnv.encrypted,
    })
    .from(instanceSkillEnv)
    .where(eq(instanceSkillEnv.instanceId, instanceId));

  return rows.map((r) => ({
    skillSlug: r.skillSlug,
    key: r.key,
    encrypted: r.encrypted,
    hasValue: r.value != null && r.value !== "",
    // Omit actual values from export bundle to prevent secret leakage
  }));
}
