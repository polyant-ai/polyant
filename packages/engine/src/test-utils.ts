// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared test factories and mock builders.
 */

import { vi } from "vitest";
import type { IncomingMessage, MessageChannelType } from "./channels/types.js";
import type { ChatResponse, AILogEntry, ModelTier } from "./ai-gateway/types.js";
import type { AuditLogger } from "./audit/audit-logger.js";
import type { ConversationStateApi, ChannelStateIdentity } from "./conversations/state.buffer.js";
import { asAgentSlug } from "./instances/identifiers.js";

export function createMockIncomingMessage(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    channelType: "telegram" as MessageChannelType,
    channelId: "test-channel-1",
    agentId: asAgentSlug("test-user-1"),
    userName: "Test User",
    text: "Hello",
    metadata: {},
    ...overrides,
  };
}

export function createMockChatResponse(
  overrides: Partial<ChatResponse> = {},
): ChatResponse {
  return {
    text: "Mock response",
    steps: [],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    durationMs: 500,
    model: "gpt-4o",
    provider: "openai",
    ...overrides,
  };
}

export function createMockAudit(): AuditLogger {
  return { log: vi.fn() } as unknown as AuditLogger;
}

/**
 * In-memory `ctx.state` for tool tests — backs the real `ConversationStateApi`
 * surface with a plain object so tests assert against actual reads/writes
 * (not mock call counts). Seed `_channel` via `initial` to exercise
 * `ctx.state.channel`.
 */
export function createMockState(initial: Record<string, unknown> = {}): ConversationStateApi {
  const data: Record<string, unknown> = { ...initial };
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
    getAll: () => ({ ...data }),
    delete: (k) => {
      delete data[k];
    },
    get channel(): ChannelStateIdentity | undefined {
      const c = data["_channel"];
      return c && typeof c === "object" ? (c as ChannelStateIdentity) : undefined;
    },
  };
}

export function createMockAILogEntry(
  overrides: Partial<AILogEntry> = {},
): AILogEntry {
  return {
    provider: "openai",
    model: "gpt-4o",
    tier: "standard" as ModelTier,
    thinking: false,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.0075,
    durationMs: 500,
    callType: "conversation",
    ...overrides,
  };
}
