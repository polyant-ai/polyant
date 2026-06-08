// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

// ---------------------------------------------------------------------------
// Chain mock: each chained method returns the chain itself; awaiting resolves
// to the configured value.
// ---------------------------------------------------------------------------
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => self);
      }
      return chain[prop];
    },
  });
  return self;
}

// ---------------------------------------------------------------------------
// Hoisted mock DB
// ---------------------------------------------------------------------------
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
  // transaction passes the mock db itself as the tx argument
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  return { mockDb };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("./schema.js", () => ({
  conversations: {
    conversationId: "conversation_id",
    title: "title",
    summary: "summary",
    instanceId: "instance_id",
    channel: "channel",
    userIdentifier: "user_identifier",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  conversationMessages: {
    id: "id",
    conversationId: "conversation_id",
    role: "role",
    content: "content",
    steps: "steps",
    reasoning: "reasoning",
    createdAt: "created_at",
    searchVector: "search_vector",
  },
  conversationState: {
    scope: "scope",
    scopeKey: "scope_key",
    instanceId: "instance_id",
    data: "data",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  desc: vi.fn((col: unknown) => ({ type: "desc", col })),
  asc: vi.fn((col: unknown) => ({ type: "asc", col })),
  inArray: vi.fn((col: unknown, values: unknown[]) => ({ type: "inArray", col, values })),
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ type: "sql", args })), {
    raw: vi.fn(),
  }),
  count: vi.fn(() => "count"),
}));

// Import AFTER mocks are in place so the module-level singleton picks them up.
import { ConversationStore, conversationStore } from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
/** Generate a unique conversation id per test to avoid cache collisions. */
function uid(prefix = "conv"): string {
  return `${prefix}-${++idCounter}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ConversationStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // BoundedMap behaviour (tested indirectly via title/summary cache)
  // =========================================================================
  describe("BoundedMap behaviour (via cache)", () => {
    it("returns cached title without querying DB on cache hit", async () => {
      const id = uid();
      // Prime the cache via updateTitle (writes to DB + cache)
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);
      await conversationStore.updateTitle(id, "Cached Title");
      vi.clearAllMocks();

      // Now getTitle should NOT touch the DB
      const title = await conversationStore.getTitle(id);
      expect(title).toBe("Cached Title");
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("queries DB on cache miss and populates cache", async () => {
      const id = uid();
      const selChain = createChainMock([{ title: "DB Title" }]);
      mockDb.select.mockReturnValue(selChain as any);

      const title = await conversationStore.getTitle(id);
      expect(title).toBe("DB Title");
      expect(mockDb.select).toHaveBeenCalled();

      // Second call should be a cache hit
      vi.clearAllMocks();
      const title2 = await conversationStore.getTitle(id);
      expect(title2).toBe("DB Title");
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("evicts oldest entry when BoundedMap exceeds maxSize", async () => {
      // We create a fresh store so we can control its internal cache capacity.
      // The default CACHE_MAX_SIZE is 1000 — we cannot easily change it on the
      // singleton, but we CAN prove eviction by inserting 1001 titles via
      // updateTitle and then checking the first one falls back to DB.
      //
      // This is expensive with 1001 calls, but the chain mock is lightweight.
      const store = new ConversationStore();
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);

      // Insert titles 0..1000 (1001 entries; capacity is 1000)
      for (let i = 0; i <= 1000; i++) {
        await store.updateTitle(`evict-${i}`, `title-${i}`);
      }

      vi.clearAllMocks();

      // The FIRST entry (evict-0) should have been evicted
      const selChain = createChainMock([{ title: "from-db" }]);
      mockDb.select.mockReturnValue(selChain as any);

      const title = await store.getTitle("evict-0");
      expect(title).toBe("from-db");
      expect(mockDb.select).toHaveBeenCalled(); // had to query DB

      vi.clearAllMocks();

      // The LAST entry (evict-1000) should still be in cache
      const title2 = await store.getTitle("evict-1000");
      expect(title2).toBe("title-1000");
      expect(mockDb.select).not.toHaveBeenCalled(); // served from cache
    });
  });

  // =========================================================================
  // getTitle / updateTitle
  // =========================================================================
  describe("getTitle", () => {
    it("returns title from DB when cache is empty", async () => {
      const id = uid();
      const selChain = createChainMock([{ title: "Hello World" }]);
      mockDb.select.mockReturnValue(selChain as any);

      const title = await conversationStore.getTitle(id);
      expect(title).toBe("Hello World");
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("returns cached title without DB call", async () => {
      const id = uid();
      // Prime cache
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);
      await conversationStore.updateTitle(id, "Cached");
      vi.clearAllMocks();

      const title = await conversationStore.getTitle(id);
      expect(title).toBe("Cached");
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("returns null when DB returns empty rows", async () => {
      const id = uid();
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      const title = await conversationStore.getTitle(id);
      expect(title).toBeNull();
    });

    it("returns null when DB row has null title", async () => {
      const id = uid();
      const selChain = createChainMock([{ title: null }]);
      mockDb.select.mockReturnValue(selChain as any);

      const title = await conversationStore.getTitle(id);
      expect(title).toBeNull();
    });

    it("does not cache null titles", async () => {
      const id = uid();
      // First call: DB returns null
      const selChain1 = createChainMock([{ title: null }]);
      mockDb.select.mockReturnValue(selChain1 as any);
      await conversationStore.getTitle(id);

      vi.clearAllMocks();

      // Second call: should query DB again (not cached)
      const selChain2 = createChainMock([{ title: "Now exists" }]);
      mockDb.select.mockReturnValue(selChain2 as any);
      const title = await conversationStore.getTitle(id);
      expect(title).toBe("Now exists");
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("updateTitle", () => {
    it("updates DB and populates cache", async () => {
      const id = uid();
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);

      await conversationStore.updateTitle(id, "New Title");
      expect(mockDb.update).toHaveBeenCalled();

      // Verify cache is populated
      vi.clearAllMocks();
      const title = await conversationStore.getTitle(id);
      expect(title).toBe("New Title");
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getSummary / updateSummary
  // =========================================================================
  describe("getSummary", () => {
    it("returns summary from DB when cache is empty", async () => {
      const id = uid();
      const selChain = createChainMock([{ summary: "A brief summary" }]);
      mockDb.select.mockReturnValue(selChain as any);

      const summary = await conversationStore.getSummary(id);
      expect(summary).toBe("A brief summary");
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("returns cached summary without DB call", async () => {
      const id = uid();
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);
      await conversationStore.updateSummary(id, "Cached summary");
      vi.clearAllMocks();

      const summary = await conversationStore.getSummary(id);
      expect(summary).toBe("Cached summary");
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("returns null when DB returns empty rows", async () => {
      const id = uid();
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      const summary = await conversationStore.getSummary(id);
      expect(summary).toBeNull();
    });

    it("returns null when DB row has null summary", async () => {
      const id = uid();
      const selChain = createChainMock([{ summary: null }]);
      mockDb.select.mockReturnValue(selChain as any);

      const summary = await conversationStore.getSummary(id);
      expect(summary).toBeNull();
    });

    it("does not cache null summaries", async () => {
      const id = uid();
      const selChain1 = createChainMock([{ summary: null }]);
      mockDb.select.mockReturnValue(selChain1 as any);
      await conversationStore.getSummary(id);
      vi.clearAllMocks();

      const selChain2 = createChainMock([{ summary: "Now exists" }]);
      mockDb.select.mockReturnValue(selChain2 as any);
      const summary = await conversationStore.getSummary(id);
      expect(summary).toBe("Now exists");
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("updateSummary", () => {
    it("updates DB and populates cache", async () => {
      const id = uid();
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);

      await conversationStore.updateSummary(id, "Updated summary");
      expect(mockDb.update).toHaveBeenCalled();

      vi.clearAllMocks();
      const summary = await conversationStore.getSummary(id);
      expect(summary).toBe("Updated summary");
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // clearContextPrompt
  // =========================================================================
  describe("clearContextPrompt", () => {
    it("issues an UPDATE setting contextPrompt to null for the given conversationId", async () => {
      const id = uid();
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);

      await conversationStore.clearContextPrompt(id);

      expect(mockDb.update).toHaveBeenCalled();
      expect(updChain.set).toHaveBeenCalledWith({ contextPrompt: null });
      expect(updChain.where).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // ensureConversation
  // =========================================================================
  describe("ensureConversation", () => {
    it("calls insert with onConflictDoUpdate", async () => {
      const id = uid();
      const insChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insChain as any);

      await conversationStore.ensureConversation(id, asInstanceSlug("instance-1"));

      expect(mockDb.insert).toHaveBeenCalled();
      // The chain should have called .values and .onConflictDoUpdate
      expect(insChain.values).toHaveBeenCalled();
      expect(insChain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it("uses default channel 'web' when not specified", async () => {
      const id = uid();
      const insChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insChain as any);

      await conversationStore.ensureConversation(id);

      expect(insChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: id,
          instanceId: null,
          channel: "web",
          userIdentifier: null,
        }),
      );
    });

    it("passes custom channel and userIdentifier", async () => {
      const id = uid();
      const insChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insChain as any);

      await conversationStore.ensureConversation(id, asInstanceSlug("inst-x"), {
        channel: "telegram",
        userIdentifier: "user-42",
      });

      expect(insChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: id,
          instanceId: "inst-x",
          channel: "telegram",
          userIdentifier: "user-42",
        }),
      );
    });
  });

  // =========================================================================
  // appendMessages
  // =========================================================================
  describe("appendMessages", () => {
    it("does not call insert when messages array is empty", async () => {
      const id = uid();
      await conversationStore.appendMessages(id, []);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("inserts all messages when array is non-empty", async () => {
      const id = uid();
      const insChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insChain as any);

      await conversationStore.appendMessages(id, [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(insChain.values).toHaveBeenCalledWith([
        { conversationId: id, role: "user", content: "Hello", steps: null, reasoning: null, attachments: null, metadata: null },
        {
          conversationId: id,
          role: "assistant",
          content: "Hi there",
          steps: null,
          reasoning: null,
          attachments: null,
          metadata: null,
        },
      ]);
    });

    it("maps steps to null when not provided", async () => {
      const id = uid();
      const insChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insChain as any);

      await conversationStore.appendMessages(id, [
        { role: "assistant", content: "No tools" },
      ]);

      expect(insChain.values).toHaveBeenCalledWith([
        expect.objectContaining({ steps: null }),
      ]);
    });

    it("preserves steps and reasoning when provided", async () => {
      const id = uid();
      const insChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insChain as any);

      const steps = [
        {
          index: 0,
          stepType: "tool-result" as const,
          text: "",
          toolCalls: [{ toolCallId: "c1", toolName: "search", args: { q: "test" } }],
          toolResults: [{ toolCallId: "c1", result: "ok" }],
          finishReason: "tool-calls",
          durationMs: 42,
        },
      ];
      const reasoning = [
        { type: "text" as const, text: "thinking…", signature: "sig" },
      ];
      await conversationStore.appendMessages(id, [
        { role: "assistant", content: "With tools", steps, reasoning },
      ]);

      expect(insChain.values).toHaveBeenCalledWith([
        expect.objectContaining({ steps, reasoning }),
      ]);
    });

    it("strips NUL bytes from content, steps, reasoning, attachments, metadata", async () => {
      const id = uid();
      const insChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insChain as any);

      // Build NUL byte at runtime to avoid leaking literal U+0000 into the
      // test source file. Postgres would reject this NUL in both `text` and
      // `jsonb` columns (codes 22021 / 22P05). The store must strip it.
      const nul = String.fromCharCode(0);
      const dirtyContent = `prefix${nul}suffix`;
      const dirtySteps = [
        {
          index: 0,
          stepType: "tool-result" as const,
          text: `prefix${nul}suffix`,
          toolCalls: [{ toolCallId: "c1", toolName: "x", args: { q: `with${nul}nul` } }],
          toolResults: [{ toolCallId: "c1", result: `ok${nul}` }],
          finishReason: "stop",
          durationMs: 1,
        },
      ];
      const dirtyReasoning = [{ type: "text" as const, text: `r${nul}` }];
      const dirtyAttachments = [{ kind: "url", url: `https://x${nul}` }];
      const dirtyMetadata = { note: `m${nul}` };

      await conversationStore.appendMessages(id, [
        {
          role: "assistant",
          content: dirtyContent,
          steps: dirtySteps as any,
          reasoning: dirtyReasoning as any,
          attachments: dirtyAttachments as any,
          metadata: dirtyMetadata,
        },
      ]);

      const inserted = insChain.values.mock.calls[0][0][0];
      expect(inserted.content).toBe("prefixsuffix");
      expect(JSON.stringify(inserted.steps)).not.toContain(nul);
      expect(JSON.stringify(inserted.reasoning)).not.toContain(nul);
      expect(JSON.stringify(inserted.attachments)).not.toContain(nul);
      expect(JSON.stringify(inserted.metadata)).not.toContain(nul);
      // Sanity: structural shape preserved
      expect(inserted.steps[0].text).toBe("prefixsuffix");
      expect(inserted.metadata.note).toBe("m");
    });
  });

  // =========================================================================
  // getRecentMessages
  // =========================================================================
  describe("getRecentMessages", () => {
    it("returns messages in chronological order (reversed from desc query)", async () => {
      const id = uid();
      // DB returns rows in DESC order (newest first)
      const selChain = createChainMock([
        { role: "assistant", content: "Second reply" },
        { role: "user", content: "First message" },
      ]);
      mockDb.select.mockReturnValue(selChain as any);

      const messages = await conversationStore.getRecentMessages(id);

      // Should be reversed to chronological order
      expect(messages).toEqual([
        { role: "user", content: "First message" },
        { role: "assistant", content: "Second reply" },
      ]);
    });

    it("maps rows to CoreMessage format", async () => {
      const id = uid();
      const selChain = createChainMock([
        { role: "user", content: "Hey" },
      ]);
      mockDb.select.mockReturnValue(selChain as any);

      const messages = await conversationStore.getRecentMessages(id);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: "Hey" });
      // Should not have extra properties
      expect(Object.keys(messages[0])).toEqual(["role", "content"]);
    });

    it("uses default limit of 15", async () => {
      const id = uid();
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await conversationStore.getRecentMessages(id);

      expect(selChain.limit).toHaveBeenCalledWith(15);
    });

    it("accepts a custom limit", async () => {
      const id = uid();
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      await conversationStore.getRecentMessages(id, 5);

      expect(selChain.limit).toHaveBeenCalledWith(5);
    });

    it("returns empty array when no messages exist", async () => {
      const id = uid();
      const selChain = createChainMock([]);
      mockDb.select.mockReturnValue(selChain as any);

      const messages = await conversationStore.getRecentMessages(id);
      expect(messages).toEqual([]);
    });
  });

  // =========================================================================
  // listConversations
  // =========================================================================
  describe("listConversations", () => {
    it("returns paginated result with conversations and total", async () => {
      const rows = [
        {
          id: "uuid-1",
          conversation_id: "conv-1",
          title: "Chat 1",
          summary: "Sum 1",
          instance_id: "inst-a",
          instance_name: "Instance A",
          message_count: 5,
          total_tokens: 1500,
          total_cost: 0.005,
          conversation_tokens: 1200,
          conversation_cost: 0.004,
          service_tokens: 300,
          service_cost: 0.001,
          created_at: "2025-06-01T00:00:00Z",
          updated_at: "2025-06-02T00:00:00Z",
        },
      ];
      const countRows = [{ total: 42 }];

      // db.execute is called twice via Promise.all
      mockDb.execute
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce(countRows);

      const result = await conversationStore.listConversations({});

      expect(result.total).toBe(42);
      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0]).toEqual(
        expect.objectContaining({
          conversationId: "conv-1",
          title: "Chat 1",
          instanceId: "inst-a",
          instanceName: "Instance A",
          messageCount: 5,
          totalTokens: 1500,
          totalCost: 0.005,
          conversationTokens: 1200,
          conversationCost: 0.004,
          serviceTokens: 300,
          serviceCost: 0.001,
        }),
      );
    });

    it("uses default limit 20 and offset 0", async () => {
      mockDb.execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const result = await conversationStore.listConversations();

      expect(result.conversations).toEqual([]);
      expect(result.total).toBe(0);
      // db.execute should have been called twice (rows + count)
      expect(mockDb.execute).toHaveBeenCalledTimes(2);
    });

    it("handles missing optional fields gracefully", async () => {
      const rows = [
        {
          id: "uuid-2",
          conversation_id: "conv-2",
          title: null,
          summary: null,
          instance_id: null,
          instance_name: null,
          message_count: null,
          total_tokens: null,
          total_cost: null,
          conversation_tokens: null,
          conversation_cost: null,
          service_tokens: null,
          service_cost: null,
          created_at: null,
          updated_at: null,
        },
      ];
      mockDb.execute
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ total: 1 }]);

      const result = await conversationStore.listConversations({});

      const conv = result.conversations[0];
      expect(conv.title).toBeNull();
      expect(conv.summary).toBeNull();
      expect(conv.instanceId).toBeNull();
      expect(conv.instanceName).toBeNull();
      expect(conv.messageCount).toBe(0);
      expect(conv.totalTokens).toBe(0);
      expect(conv.totalCost).toBe(0);
      expect(conv.conversationTokens).toBe(0);
      expect(conv.conversationCost).toBe(0);
      expect(conv.serviceTokens).toBe(0);
      expect(conv.serviceCost).toBe(0);
      expect(conv.createdAt).toBeNull();
      expect(conv.updatedAt).toBeNull();
    });

    it("returns total 0 when count result is empty", async () => {
      mockDb.execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await conversationStore.listConversations({});

      expect(result.total).toBe(0);
    });
  });

  // =========================================================================
  // getConversation
  // =========================================================================
  describe("getConversation", () => {
    it("returns ConversationDetail when found", async () => {
      const row = {
        id: "uuid-1",
        conversation_id: "conv-abc",
        title: "My Chat",
        summary: "A summary",
        instance_id: "inst-1",
        instance_name: "Bot 1",
        message_count: 10,
        total_tokens: 2000,
        total_cost: 0.008,
        conversation_tokens: 1500,
        conversation_cost: 0.006,
        service_tokens: 500,
        service_cost: 0.002,
        created_at: "2025-06-01T00:00:00Z",
        updated_at: "2025-06-02T00:00:00Z",
      };
      mockDb.execute.mockResolvedValueOnce([row]);

      const result = await conversationStore.getConversation("conv-abc");

      expect(result).not.toBeNull();
      expect(result!.conversationId).toBe("conv-abc");
      expect(result!.title).toBe("My Chat");
      expect(result!.instanceName).toBe("Bot 1");
      expect(result!.messageCount).toBe(10);
      expect(result!.totalTokens).toBe(2000);
      expect(result!.totalCost).toBe(0.008);
      expect(result!.conversationTokens).toBe(1500);
      expect(result!.conversationCost).toBe(0.006);
      expect(result!.serviceTokens).toBe(500);
      expect(result!.serviceCost).toBe(0.002);
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.updatedAt).toBeInstanceOf(Date);
    });

    it("returns null when not found (empty result)", async () => {
      mockDb.execute.mockResolvedValueOnce([]);

      const result = await conversationStore.getConversation("nonexistent");
      expect(result).toBeNull();
    });

    it("handles null dates gracefully", async () => {
      const row = {
        id: "uuid-2",
        conversation_id: "conv-xyz",
        title: null,
        summary: null,
        instance_id: null,
        instance_name: null,
        message_count: 0,
        total_tokens: 0,
        total_cost: 0,
        conversation_tokens: 0,
        conversation_cost: 0,
        service_tokens: 0,
        service_cost: 0,
        created_at: null,
        updated_at: null,
      };
      mockDb.execute.mockResolvedValueOnce([row]);

      const result = await conversationStore.getConversation("conv-xyz");

      expect(result).not.toBeNull();
      expect(result!.createdAt).toBeNull();
      expect(result!.updatedAt).toBeNull();
    });
  });

  // =========================================================================
  // getMessages
  // =========================================================================
  describe("getMessages", () => {
    it("returns paginated messages with total count", async () => {
      const msgRows = [
        {
          id: "msg-1",
          role: "user",
          content: "Hello",
          steps: null,
          attachments: null,
          metadata: null,
          createdAt: new Date("2025-06-01"),
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Hi!",
          steps: null,
          attachments: null,
          metadata: null,
          createdAt: new Date("2025-06-01"),
        },
      ];
      const countRows = [{ total: 25 }];

      // getMessages uses Promise.all with two db calls:
      // 1. db.select (chain) for messages
      // 2. db.select (chain) for count
      const msgChain = createChainMock(msgRows);
      const countChain = createChainMock(countRows);

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1
          ? (msgChain as any)
          : (countChain as any);
      });

      const result = await conversationStore.getMessages("conv-1");

      expect(result.total).toBe(25);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({
        id: "msg-1",
        role: "user",
        content: "Hello",
        steps: null,
        reasoning: null,
        attachments: null,
        metadata: null,
        createdAt: new Date("2025-06-01"),
      });
    });

    it("exposes audio metadata when present (e.g. transcribed voice messages)", async () => {
      const audioMeta = {
        messageSid: "MM123",
        originalKind: "audio",
        audio: { durationSec: 1.5, sttProvider: "openai", language: "italian", latencyMs: 1200 },
      };
      const msgRows = [
        {
          id: "msg-1",
          role: "user",
          content: "Cosa è previsto sul menù?",
          steps: null,
          attachments: null,
          metadata: audioMeta,
          createdAt: new Date("2025-06-01"),
        },
      ];
      const msgChain = createChainMock(msgRows);
      const countChain = createChainMock([{ total: 1 }]);

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1
          ? (msgChain as any)
          : (countChain as any);
      });

      const result = await conversationStore.getMessages("conv-1");
      expect(result.messages[0].metadata).toEqual(audioMeta);
    });

    it("uses default limit 50 and offset 0", async () => {
      const msgChain = createChainMock([]);
      const countChain = createChainMock([{ total: 0 }]);

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1
          ? (msgChain as any)
          : (countChain as any);
      });

      await conversationStore.getMessages("conv-1");

      expect(msgChain.limit).toHaveBeenCalledWith(50);
      expect(msgChain.offset).toHaveBeenCalledWith(0);
    });

    it("returns total 0 when count result is empty", async () => {
      const msgChain = createChainMock([]);
      const countChain = createChainMock([]);

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1
          ? (msgChain as any)
          : (countChain as any);
      });

      const result = await conversationStore.getMessages("conv-1");
      expect(result.total).toBe(0);
      expect(result.messages).toEqual([]);
    });

    it("coerces null steps to null", async () => {
      const msgRows = [
        {
          id: "msg-1",
          role: "assistant",
          content: "Reply",
          steps: null,
          createdAt: null,
        },
      ];
      const msgChain = createChainMock(msgRows);
      const countChain = createChainMock([{ total: 1 }]);

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1
          ? (msgChain as any)
          : (countChain as any);
      });

      const result = await conversationStore.getMessages("conv-1");
      expect(result.messages[0].steps).toBeNull();
      expect(result.messages[0].createdAt).toBeNull();
    });
  });

  // =========================================================================
  // deleteConversation
  // =========================================================================
  describe("deleteConversation", () => {
    // Order: messages, ai_logs, pipeline_traces, tool_audit_logs, memories, conversation_state, conversations
    const EXPECTED_DELETE_CALLS = 7;

    it("cascades delete across all conversation-scoped tables and returns true when found", async () => {
      const id = uid();
      const sideChain = createChainMock(undefined);
      const delConvChain = createChainMock([{ id: "uuid-1" }]); // returning has length > 0

      let deleteCallCount = 0;
      mockDb.delete.mockImplementation((_table: unknown) => {
        deleteCallCount++;
        // The conversations table delete is the last one (returning() chain).
        return deleteCallCount === EXPECTED_DELETE_CALLS
          ? (delConvChain as any)
          : (sideChain as any);
      });

      const result = await conversationStore.deleteConversation(id);

      expect(result).toBe(true);
      expect(mockDb.delete).toHaveBeenCalledTimes(EXPECTED_DELETE_CALLS);
    });

    it("returns false when conversation not found (empty returning)", async () => {
      const id = uid();
      const sideChain = createChainMock(undefined);
      const delConvChain = createChainMock([]); // returning has length === 0

      let deleteCallCount = 0;
      mockDb.delete.mockImplementation(() => {
        deleteCallCount++;
        return deleteCallCount === EXPECTED_DELETE_CALLS
          ? (delConvChain as any)
          : (sideChain as any);
      });

      const result = await conversationStore.deleteConversation(id);
      expect(result).toBe(false);
    });

    it("clears both title and summary cache", async () => {
      const id = uid();

      // Prime both caches
      const updChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updChain as any);
      await conversationStore.updateTitle(id, "Title to clear");
      await conversationStore.updateSummary(id, "Summary to clear");

      vi.clearAllMocks();

      // Delete the conversation (cascades across 7 tables; conversations is the last one)
      const sideChain = createChainMock(undefined);
      const delConvChain = createChainMock([{ id: "uuid-1" }]);
      let deleteCallCount = 0;
      mockDb.delete.mockImplementation(() => {
        deleteCallCount++;
        return deleteCallCount === EXPECTED_DELETE_CALLS
          ? (delConvChain as any)
          : (sideChain as any);
      });
      await conversationStore.deleteConversation(id);

      vi.clearAllMocks();

      // Now getTitle and getSummary should hit DB (cache was cleared)
      const selChainTitle = createChainMock([{ title: "Reloaded" }]);
      mockDb.select.mockReturnValue(selChainTitle as any);
      const title = await conversationStore.getTitle(id);
      expect(title).toBe("Reloaded");
      expect(mockDb.select).toHaveBeenCalled();

      vi.clearAllMocks();

      const selChainSummary = createChainMock([{ summary: "Reloaded" }]);
      mockDb.select.mockReturnValue(selChainSummary as any);
      const summary = await conversationStore.getSummary(id);
      expect(summary).toBe("Reloaded");
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // replaceOldestMessages (#99) — transactional compaction
  // =========================================================================
  describe("replaceOldestMessages (#99)", () => {
    it("wraps delete + insert in a single transaction", async () => {
      const selectChain = createChainMock([{ id: "m1" }, { id: "m2" }]);
      const deleteChain = createChainMock([{ id: "m1" }]);
      const insertChain = createChainMock(undefined);
      mockDb.select.mockReturnValue(selectChain as any);
      mockDb.delete.mockReturnValue(deleteChain as any);
      mockDb.insert.mockReturnValue(insertChain as any);

      const store = new ConversationStore();
      await store.replaceOldestMessages(uid("conv"), 2, "Summary here");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it("returns early (no delete, no insert) when there are no messages to compact", async () => {
      const selectChain = createChainMock([]);
      mockDb.select.mockReturnValue(selectChain as any);

      const store = new ConversationStore();
      await store.replaceOldestMessages(uid("empty"), 5, "unused");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockDb.delete).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("does NOT delete anything if the transaction callback throws", async () => {
      const selectChain = createChainMock([{ id: "m1" }]);
      const failingDelete = {
        where: vi.fn().mockRejectedValue(new Error("simulated db error")),
      };
      mockDb.select.mockReturnValue(selectChain as any);
      mockDb.delete.mockReturnValue(failingDelete as any);

      // Wire the transaction mock so rejections propagate — this is the real
      // contract: a failure inside the callback must surface, not be swallowed.
      mockDb.transaction.mockImplementationOnce(
        async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
      );

      const store = new ConversationStore();
      await expect(
        store.replaceOldestMessages(uid("fail"), 1, "Summary"),
      ).rejects.toThrow("simulated db error");

      // Insert must not have happened after the delete rejection.
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Singleton export
  // =========================================================================
  describe("module exports", () => {
    it("exports a singleton conversationStore that is an instance of ConversationStore", () => {
      expect(conversationStore).toBeInstanceOf(ConversationStore);
    });
  });
});
