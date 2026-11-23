// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Typed builders for the agent-page tabs' API fixtures (models, skills,
 * scheduled tasks, management keys). Each returns a value that satisfies the
 * declared API type, so a field the panel starts requiring breaks here, once.
 */
import type { ManagementApiKey, ModelInfo, ScheduledTask } from "@/lib/api-types";

export function makeModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "gpt-4o",
    tier: "standard",
    costInput: 0.01,
    costOutput: 0.03,
    costCacheRead: 0.01,
    costCacheWrite: 0,
    supportsCache: true,
    supportsThinking: false,
    reasoningAlwaysOn: false,
    reasoningLevels: [],
    supportsTemperature: true,
    supportsTemperatureWithThinking: false,
    ...overrides,
  };
}

export function makeManagementApiKey(overrides: Partial<ManagementApiKey> = {}): ManagementApiKey {
  return {
    id: "key-1",
    name: "ci",
    permissions: [],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeScheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Task",
    description: null,
    schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    scheduleHuman: "Every day at 09:00",
    prompt: "Do it",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    lastConversationId: null,
    consecutiveErrors: 0,
    totalRuns: 0,
    deleteAfterRun: false,
    maxRetries: 0,
    maxRunMs: null,
    outboundChannel: null,
    outboundTarget: null,
    keepHistory: true,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}
