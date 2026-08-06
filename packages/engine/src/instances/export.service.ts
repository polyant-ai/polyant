// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Export service — assembles instance bundles from all stores
// ---------------------------------------------------------------------------

import { eq, and } from "drizzle-orm";
import { db } from "../database/client.js";
import { findInstanceBySlug, type Agent } from "./store.js";
import { asAgentSlug, type AgentUuid } from "./identifiers.js";
import { getPrompts } from "./prompts.store.js";
import { getInstanceSkills } from "./instance-skills.store.js";
import { instanceTools } from "./instance-tools.schema.js";
import { tools } from "../agents/tools/tools.schema.js";
import { instanceSecrets } from "./secrets.schema.js";
import { instanceChannels } from "./channels.schema.js";
import { instanceSkillEnv } from "./skill-env.schema.js";
import { decrypt } from "../crypto/index.js";
import { getRoomByInstanceId } from "../room/room.store.js";
import { listEventSourcesWithDefinitions } from "../webhooks/webhook-sources.store.js";
import { listByInstance as listScheduledTasks } from "../scheduled-tasks/store.js";
import { listHooks } from "../hooks/hooks.store.js";
import { listMcpServers, type McpAuthMode } from "./mcp-servers.store.js";
import { MCP_SECRET_PATHS } from "../server/instances/mcp-config-mask.js";
import { INSTANCE_BUNDLE_VERSION, type InstanceBundle, type ExportInstanceData } from "./export.schema.js";

// Credential-like config keys, stripped from channel config before export so a
// bundle never carries secrets at rest. Mirrors the masking rule used by the
// management API (instance-helpers.ts) — kept local to avoid a server→domain dep.
const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|key|credential)/i;

/** Return a copy of `config` with credential-like keys removed. */
export function stripSensitiveKeys(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key)),
  );
}

// ---------------------------------------------------------------------------
// Export instance
// ---------------------------------------------------------------------------

export async function exportInstance(slug: string): Promise<InstanceBundle> {
  const instance = await findInstanceBySlug(asAgentSlug(slug));
  if (!instance) throw new Error(`Agent "${slug}" not found`);

  const data = await assembleInstanceData(instance);

  return {
    version: INSTANCE_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    type: "instance",
    instance: data,
  };
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

async function assembleInstanceData(instance: Agent): Promise<ExportInstanceData> {
  // Parallel reads — all independent queries
  const [
    prompts,
    skillAssignments,
    manualToolNames,
    secretKeys,
    channels,
    skillEnvRows,
    hooks,
    roomConfig,
    eventSourcesWithDefs,
    tasks,
    mcpServers,
  ] = await Promise.all([
    exportPrompts(instance.id),
    exportSkillAssignments(instance.id),
    exportManualTools(instance.id),
    exportSecretKeys(instance.id),
    exportChannels(instance.id),
    exportSkillEnv(instance.id),
    exportHooks(instance.id),
    getRoomByInstanceId(instance.id),
    listEventSourcesWithDefinitions(instance.slug),
    // scheduled_tasks.agent_id is stored as the SLUG (text column, not
    // a UUID FK) — every other caller in the system (controller, scheduler,
    // schedule-task tool) reads/writes it as the slug. The export must
    // match or it would always return an empty array.
    listScheduledTasks(instance.slug),
    exportMcpServers(instance.id),
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
    langsmithProject: instance.langsmithProject,
    thinkingEnabled: instance.thinkingEnabled,
    temperature: instance.temperature,
    stateInPromptEnabled: instance.stateInPromptEnabled,
    datetimeInjectionEnabled: instance.datetimeInjectionEnabled,
    cacheEnabled: instance.cacheEnabled,
    cacheTtl: instance.cacheTtl === "5m" ? "5m" : "1h",
    a2aEnabled: instance.a2aEnabled,
    toolResultsInHistoryEnabled: instance.toolResultsInHistoryEnabled,
    debugEnabled: instance.debugEnabled,
    sttProvider: instance.sttProvider,
    embeddingProvider: instance.embeddingProvider,
    embeddingDim: instance.embeddingDim,
    optoutEnabled: instance.optoutEnabled,
    optoutStopKeywords: instance.optoutStopKeywords,
    optoutResumeKeywords: instance.optoutResumeKeywords,
    optoutClosingMessage: instance.optoutClosingMessage,
    optoutResumeMessage: instance.optoutResumeMessage,
    optoutInjectPromptHint: instance.optoutInjectPromptHint,
    prompts,
    skills: skillAssignments,
    manualTools: manualToolNames,
    secrets: secretKeys,
    channels,
    skillEnv: skillEnvRows,
    hooks,
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
        action: d.action,
        contextPrompt: d.contextPrompt,
        outboundChannel: d.outboundChannel,
        outboundTarget: d.outboundTarget,
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
    mcpServers,
  };
}

async function exportPrompts(instanceId: AgentUuid) {
  const rows = await getPrompts(instanceId);
  return rows.map((r) => ({
    sectionKey: r.sectionKey,
    title: r.title,
    content: r.content,
  }));
}

async function exportSkillAssignments(instanceId: AgentUuid) {
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
      config: instanceChannels.config,
    })
    .from(instanceChannels)
    .where(eq(instanceChannels.instanceId, instanceId));
  return rows.map((r) => ({
    channelType: r.channelType,
    enabled: r.enabled,
    // Decrypt the stored config and strip credential-like keys — the bundle
    // carries only the non-secret settings (e.g. allowedUserIds, whatsappNumber,
    // and the credential-less `agent` channel's passthrough config).
    config: stripSensitiveKeys(safeDecryptChannelConfig(r.config)),
  }));
}

/** Decrypt a channel config blob, tolerating empty/legacy/invalid values. */
function safeDecryptChannelConfig(encrypted: string): Record<string, unknown> {
  if (!encrypted || !encrypted.includes(":")) return {};
  try {
    return JSON.parse(decrypt(encrypted)) as Record<string, unknown>;
  } catch {
    return {};
  }
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
    // Only carry plaintext values for non-encrypted env vars; encrypted values
    // are omitted to prevent secret leakage (re-configured on import).
    value: r.encrypted ? undefined : (r.value ?? ""),
  }));
}

async function exportHooks(instanceId: AgentUuid) {
  const rows = await listHooks(instanceId);
  return rows.map((h) => ({
    event: h.event,
    actionType: h.actionType,
    actionConfig: h.actionConfig as unknown as Record<string, unknown>,
    enabled: h.enabled,
    position: h.position,
    timeoutMs: h.timeoutMs,
  }));
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

// stripSensitiveKeys (above) is FLAT (top-level key-name matching) — MCP
// secrets are NESTED (config.auth.token, config.staticClient.clientSecret,
// config.dcrClient.client_secret), so a flat strip would miss them entirely.
// The leaf paths themselves come from the SAME MCP_SECRET_PATHS const that
// server/instances/mcp-config-mask.ts uses to MASK those fields for API
// responses — a single source of truth, so a future secret field added to
// one and missed in the other can't silently leak. Here we DELETE the field
// (rather than mask it) — a bundle must never carry a token/secret at rest.
// authServerInfo is left untouched — it only carries the authorization
// server's public URLs.
function deleteAtPath(obj: Record<string, unknown>, path: string[]): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (typeof next !== "object" || next === null) return;
    cur = next as Record<string, unknown>;
  }
  delete cur[path[path.length - 1]];
}

export function stripMcpSecrets(authMode: McpAuthMode, config: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(config);
  for (const path of MCP_SECRET_PATHS[authMode]) {
    deleteAtPath(copy, path);
  }
  // Beyond the shared leaf paths: dcrClient is dropped ENTIRELY (not just its
  // client_secret leaf) because a DCR registration response also carries a
  // registration_access_token — a second bearer credential the mask's leaf
  // list doesn't need to know about (the response path redacts client_secret
  // per-field), but an export has no use for a DCR client anyway — a fresh
  // connect flow re-registers it.
  delete copy.dcrClient;
  return copy;
}

export async function exportMcpServers(instanceId: InstanceUuid) {
  const rows = await listMcpServers(instanceId);
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    url: r.url,
    authMode: r.authMode,
    enabled: r.enabled,
    config: stripMcpSecrets(r.authMode, r.config as Record<string, unknown>),
  }));
}
