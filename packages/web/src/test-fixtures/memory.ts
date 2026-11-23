// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Memory } from "@/lib/api-types";

export function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    instanceId: "a1",
    content: "Lives in Rome",
    category: "fact",
    importance: 5,
    sourceConversationId: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

/** A page of memories, in the shape `api.memories.list` resolves. */
export function makeMemoryPage(memories: Memory[] = [], overrides: { total?: number; limit?: number; offset?: number } = {}) {
  return { memories, total: memories.length, limit: 20, offset: 0, ...overrides };
}
