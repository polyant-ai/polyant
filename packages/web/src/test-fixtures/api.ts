// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Typed builders for the entities most panel tests fake. Each returns a value
 * that satisfies the declared API type, so a field the panel starts requiring
 * (or renames) breaks here, in one place, instead of silently leaving every
 * test with a stale hand-written shape.
 */
import type { ChannelConfig, Instance, ToolState } from "@/lib/api-types";

export function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "a1",
    name: "A1",
    description: null,
    status: "active",
    provider: "openai",
    model: "gpt-4o",
    effectiveProvider: "openai",
    effectiveModel: "gpt-4o",
    memoryEnabled: false,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: true,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    datetimeInjectionEnabled: false,
    datetimeTimezone: null,
    datetimeLocale: null,
    dedupSimilarityThreshold: null,
    messageSoftDebounceMs: null,
    messageTypingDelayMs: null,
    messageMaxRestarts: null,
    cacheEnabled: true,
    cacheTtl: "5m",
    intermediateText: null,
    a2aEnabled: false,
    toolResultsInHistoryEnabled: false,
    toolHistoryReplay: "compact",
    debugEnabled: false,
    attachmentStorageEnabled: false,
    optoutEnabled: false,
    optoutStopKeywords: [],
    optoutResumeKeywords: [],
    optoutClosingMessage: null,
    optoutResumeMessage: null,
    optoutInjectPromptHint: false,
    webContextFieldMapping: {},
    sttProvider: null,
    icon: null,
    embeddingProvider: "openai",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

export function makeToolState(overrides: Partial<ToolState> = {}): ToolState {
  return { name: "t1", description: "", category: "general", enabled: true, ...overrides };
}

export function makeChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return { channelType: "telegram", enabled: true, config: {}, ...overrides };
}
