// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Export/Import bundle — Zod schemas
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const exportPromptSchema = z.object({
  sectionKey: z.string(),
  title: z.string(),
  content: z.string(),
});

export const exportSkillAssignmentSchema = z.object({
  skillSlug: z.string(),
  enabled: z.boolean(),
  autoLoad: z.boolean(),
  pinnedVersion: z.string(),
});

export const exportSecretSchema = z.object({
  key: z.string(),
  configured: z.boolean(),
});

export const exportChannelSchema = z.object({
  channelType: z.string(),
  enabled: z.boolean(),
  // Non-secret config only — credential-like keys (token/secret/password/key/
  // credential) are stripped at export time. Defaulted for 1.0 back-compat.
  config: z.record(z.unknown()).default({}),
});

export const exportHookSchema = z.object({
  event: z.string(),
  actionType: z.string(),
  // { toolName, args } — args are static {{path}} templates, never secrets.
  actionConfig: z.record(z.unknown()),
  enabled: z.boolean(),
  position: z.number(),
  timeoutMs: z.number(),
});

export const exportSkillEnvSchema = z.object({
  skillSlug: z.string(),
  key: z.string(),
  encrypted: z.boolean(),
  value: z.string().optional(), // only present for non-encrypted values
});

export const exportRoomSchema = z.object({
  enabled: z.boolean(),
  prompt: z.string(),
  outboundChannel: z.string().nullable(),
  outboundTarget: z.string().nullable(),
  evalIntervalMinutes: z.number(),
});

export const exportEventDefinitionSchema = z.object({
  name: z.string(),
  matchingPrompt: z.string(),
  interpretationPrompt: z.string(),
  enabled: z.boolean(),
  // Routing/action fields — defaulted for 1.0 back-compat.
  action: z.string().default("backlog"),
  contextPrompt: z.string().nullable().default(null),
  outboundChannel: z.string().nullable().default(null),
  outboundTarget: z.string().nullable().default(null),
});

export const exportEventSourceSchema = z.object({
  name: z.string(),
  sourceType: z.string(),
  enabled: z.boolean(),
  definitions: z.array(exportEventDefinitionSchema),
});

export const exportScheduledTaskSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  schedule: z.object({ type: z.string() }).passthrough(), // ScheduleConfig union
  prompt: z.string(),
  outboundChannel: z.string().nullable(),
  outboundTarget: z.string().nullable(),
  keepHistory: z.boolean(),
  deleteAfterRun: z.boolean(),
  maxRetries: z.number(),
  createdBy: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Instance bundle
// ---------------------------------------------------------------------------

export const exportInstanceDataSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  memoryEnabled: z.boolean(),
  knowledgeEnabled: z.boolean(),
  langsmithEnabled: z.boolean(),
  authEnabled: z.boolean(),
  icon: z.string().nullable().optional(),
  // --- Behaviour flags + config added after the 1.0 format. All defaulted so
  //     legacy 1.0 bundles (which lack them) keep validating. ---
  langsmithProject: z.string().nullable().default(null),
  thinkingEnabled: z.boolean().default(false),
  temperature: z.number().nullable().default(null),
  stateInPromptEnabled: z.boolean().default(false),
  toolResultsInHistoryEnabled: z.boolean().default(false),
  debugEnabled: z.boolean().default(false),
  sttProvider: z.string().default("openai"),
  // Embedding provider/dim are applied on import-NEW only — switching them on an
  // existing instance is destructive (wipes vectors), so import-OVERWRITE leaves
  // them untouched. See import.service.ts.
  embeddingProvider: z.string().default("openai"),
  embeddingDim: z.number().default(1536),
  // GDPR opt-out config (six columns on `instances`).
  optoutEnabled: z.boolean().default(false),
  optoutStopKeywords: z.array(z.string()).default(["STOP"]),
  optoutResumeKeywords: z.array(z.string()).default(["START"]),
  optoutClosingMessage: z.string().nullable().default(null),
  optoutResumeMessage: z.string().nullable().default(null),
  optoutInjectPromptHint: z.boolean().default(true),
  prompts: z.array(exportPromptSchema),
  skills: z.array(exportSkillAssignmentSchema),
  manualTools: z.array(z.string()),
  secrets: z.array(exportSecretSchema),
  channels: z.array(exportChannelSchema),
  skillEnv: z.array(exportSkillEnvSchema),
  hooks: z.array(exportHookSchema).default([]),
  room: exportRoomSchema.nullable(),
  eventSources: z.array(exportEventSourceSchema),
  scheduledTasks: z.array(exportScheduledTaskSchema).default([]),
});

// ---------------------------------------------------------------------------
// Top-level bundle envelope
// ---------------------------------------------------------------------------

/** Current bundle format version emitted by the exporter. */
export const INSTANCE_BUNDLE_VERSION = "1.1" as const;

export const instanceBundleSchema = z.object({
  // Accept both the legacy 1.0 format and the current 1.1 (additive) format.
  version: z.union([z.literal("1.0"), z.literal("1.1")]),
  exportedAt: z.string(),
  type: z.literal("instance"),
  instance: exportInstanceDataSchema,
});

export type InstanceBundle = z.infer<typeof instanceBundleSchema>;
export type ExportInstanceData = z.infer<typeof exportInstanceDataSchema>;

// ---------------------------------------------------------------------------
// Skills catalog bundle
// ---------------------------------------------------------------------------

export const exportSkillVersionSchema = z.object({
  version: z.string(),
  content: z.string(),
  metadata: z.record(z.unknown()).default({}),
  scripts: z.array(z.object({
    file: z.string(),
    description: z.string(),
    content: z.string(),
  })).default([]),
  changelog: z.string().nullable().optional(),
});

export const exportSkillCatalogEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  isDefault: z.boolean(),
  versions: z.array(exportSkillVersionSchema),
});

export const skillsCatalogBundleSchema = z.object({
  version: z.literal("1.0"),
  exportedAt: z.string(),
  type: z.literal("skills"),
  skills: z.array(exportSkillCatalogEntrySchema),
});

export type SkillsCatalogBundle = z.infer<typeof skillsCatalogBundleSchema>;
