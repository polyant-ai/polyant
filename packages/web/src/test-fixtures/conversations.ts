// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Typed builders for the conversation list a panel test fakes, so a field the
 * list starts returning (or renames) breaks here instead of leaving each test
 * with its own stale shape.
 */
import type { ConversationListItem } from "@/lib/api-types";

export function makeConversationListItem(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "c1",
    conversationId: "conv-1",
    title: "Test Conversation",
    summary: "A summary",
    channel: "telegram",
    userIdentifier: null,
    instanceId: "inst-1",
    instanceName: "My Instance",
    messageCount: 5,
    totalTokens: 1200,
    totalCost: 0.0035,
    conversationTokens: 1000,
    conversationCost: 0.003,
    serviceTokens: 200,
    serviceCost: 0.0005,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

/** The `conversations.list` response: the page of rows plus the paging it was asked for. */
export function makeConversationList(
  conversations: ConversationListItem[],
  overrides: { total?: number; limit?: number; offset?: number } = {},
) {
  return { conversations, total: conversations.length, limit: 20, offset: 0, ...overrides };
}
