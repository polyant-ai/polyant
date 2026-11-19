// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation store's writes and single-conversation reads against a real
 * Postgres: the title cache, what a saved message keeps, the read of one
 * conversation and its messages, and the rename and delete cascades. Listing,
 * search, recent history, debug, counters and the cross-tenant refusals have
 * their own integration files beside this one and in `authz/`.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { orgScope, workspaceSetScope, type TenantScope } from "../authz/scope-filter.js";
import { asInstanceSlug, type InstanceSlug } from "../instances/identifiers.js";
import { ConversationStore, conversationStore } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = `itest-cstore-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let agent: InstanceSlug;
let scope: TenantScope;
let n = 0;

/** A fresh conversation id of this run. */
const convId = (label = "c") => `${MARKER}-${label}-${++n}`;

async function newConversation(label?: string, values: { title?: string; userIdentifier?: string } = {}): Promise<string> {
  const id = convId(label);
  await queryClient`
    INSERT INTO conversations (conversation_id, instance_id, title, user_identifier)
    VALUES (${id}, ${agent}, ${values.title ?? null}, ${values.userIdentifier ?? null})`;
  return id;
}

async function setTitleInDb(id: string, title: string | null): Promise<void> {
  await queryClient`UPDATE conversations SET title = ${title} WHERE conversation_id = ${id}`;
}

async function count(table: "conversation_messages" | "ai_logs" | "conversation_state", id: string): Promise<number> {
  const column = table === "conversation_state" ? "scope_key" : "conversation_id";
  const [row] = await queryClient<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${queryClient(table)} WHERE ${queryClient(column)} = ${id}`;
  return row!.n;
}

async function addAiLog(id: string, callType: "conversation" | "service", tokens: number, cost: number): Promise<void> {
  await queryClient`
    INSERT INTO ai_logs (provider, model, tier, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, duration_ms, call_type, conversation_id)
    VALUES ('openai', 'gpt-4o', 'standard', ${tokens}, 0, ${tokens}, ${cost}, 1, ${callType}, ${id})`;
}

describe.skipIf(!DB_AVAILABLE)("conversation store (integration)", () => {
  beforeAll(async () => {
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, ${MARKER}, false) RETURNING id`;
    const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, ${MARKER}, false) RETURNING id`;
    agent = asInstanceSlug(`${MARKER}-agent`);
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${agent}, 'Cstore agent', ${workspaceId})`;
    scope = orgScope(orgId);
  });

  afterAll(async () => {
    await queryClient`DELETE FROM ai_logs WHERE conversation_id LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM conversation_state WHERE scope_key LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
  });

  describe("title", () => {
    it("saves a normalized title and answers later reads from the cache", async () => {
      const store = new ConversationStore();
      const id = await newConversation();

      await store.updateTitle(id, '"User: Prenotare una visita"');
      const [row] = await queryClient<{ title: string }[]>`SELECT title FROM conversations WHERE conversation_id = ${id}`;
      expect(row!.title).toBe("Prenotare una visita");

      // Changed behind the store's back: the cached title still answers.
      await setTitleInDb(id, "changed elsewhere");
      expect(await store.getTitle(id)).toBe("Prenotare una visita");
    });

    it("reads a title it has not cached from the database, then keeps it", async () => {
      const store = new ConversationStore();
      const id = await newConversation("t", { title: "From the database" });

      expect(await store.getTitle(id)).toBe("From the database");
      await setTitleInDb(id, "changed elsewhere");
      expect(await store.getTitle(id)).toBe("From the database");
    });

    it("does not cache a missing title", async () => {
      const store = new ConversationStore();
      const id = await newConversation();

      expect(await store.getTitle(id)).toBeNull();
      expect(await store.getTitle(convId("missing"))).toBeNull();
      await setTitleInDb(id, "Set later");
      expect(await store.getTitle(id)).toBe("Set later");
    });

    it("forgets the oldest title once a thousand newer ones are cached", async () => {
      const store = new ConversationStore();
      // No rows: every title the store returns below comes from its cache.
      for (let i = 0; i <= 1000; i++) await store.updateTitle(`${MARKER}-evict-${i}`, `title ${i}`);

      expect(await store.getTitle(`${MARKER}-evict-0`)).toBeNull();
      expect(await store.getTitle(`${MARKER}-evict-1000`)).toBe("title 1000");
    }, 30_000);

    it("a delete and a rename drop the cached title", async () => {
      const store = new ConversationStore();
      const deleted = await newConversation();
      const renamed = await newConversation();
      await store.updateTitle(deleted, "Gone");
      await store.updateTitle(renamed, "Moved");

      await store.deleteConversation(deleted, scope);
      await store.renameConversation(renamed, `${renamed}-new`, scope);

      expect(await store.getTitle(deleted)).toBeNull();
      expect(await store.getTitle(renamed)).toBeNull();
    });
  });

  it("clears the context prompt of the conversation", async () => {
    const id = await newConversation();
    await queryClient`UPDATE conversations SET context_prompt = 'one-shot' WHERE conversation_id = ${id}`;

    await conversationStore.clearContextPrompt(id);

    const [row] = await queryClient<{ context_prompt: string | null }[]>`SELECT context_prompt FROM conversations WHERE conversation_id = ${id}`;
    expect(row!.context_prompt).toBeNull();
  });

  describe("ensureConversation", () => {
    it("creates the row once, on the web channel with no contact unless told otherwise", async () => {
      const id = convId();

      expect(await conversationStore.ensureConversation(id, agent)).toEqual({ created: true });
      expect(await conversationStore.ensureConversation(id, agent, { channel: "telegram", userIdentifier: "user-42" }))
        .toEqual({ created: false });

      const [row] = await queryClient<{ instance_id: string; channel: string; user_identifier: string | null }[]>`
        SELECT instance_id, channel, user_identifier FROM conversations WHERE conversation_id = ${id}`;
      expect(row).toEqual({ instance_id: agent, channel: "telegram", user_identifier: "user-42" });
    });

    it("stores the default channel and an empty contact on a new row", async () => {
      const id = convId();

      await conversationStore.ensureConversation(id, agent);

      const [row] = await queryClient<{ channel: string; user_identifier: string | null }[]>`
        SELECT channel, user_identifier FROM conversations WHERE conversation_id = ${id}`;
      expect(row).toEqual({ channel: "web", user_identifier: null });
    });
  });

  describe("appendMessages", () => {
    it("saves nothing and leaves the conversation untouched for an empty list", async () => {
      const id = await newConversation();
      const [before] = await queryClient<{ updated_at: Date }[]>`SELECT updated_at FROM conversations WHERE conversation_id = ${id}`;

      await conversationStore.appendMessages(id, []);

      expect(await count("conversation_messages", id)).toBe(0);
      const [after] = await queryClient<{ updated_at: Date }[]>`SELECT updated_at FROM conversations WHERE conversation_id = ${id}`;
      expect(String(after!.updated_at)).toBe(String(before!.updated_at));
    });

    it("saves every message with its steps and reasoning, and moves the conversation's activity time", async () => {
      const id = await newConversation();
      await queryClient`UPDATE conversations SET updated_at = '2020-01-01T00:00:00Z' WHERE conversation_id = ${id}`;
      const steps = [{ index: 0, stepType: "tool-result" as const, text: "", toolCalls: [{ toolCallId: "c1", toolName: "search", args: { q: "test" } }], toolResults: [{ toolCallId: "c1", result: "ok" }], finishReason: "tool-calls", durationMs: 42 }];
      const reasoning = [{ type: "text" as const, text: "thinking…", signature: "sig" }];

      await conversationStore.appendMessages(id, [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "With tools", steps, reasoning },
      ]);

      const { messages } = await conversationStore.getMessages(id);
      expect(messages.map((m) => [m.role, m.content])).toEqual([["user", "Hello"], ["assistant", "With tools"]]);
      expect(messages[0]).toMatchObject({ steps: null, reasoning: null, attachments: null, metadata: null });
      expect(messages[1]).toMatchObject({ steps, reasoning });
      const [row] = await queryClient<{ updated_at: Date }[]>`SELECT updated_at FROM conversations WHERE conversation_id = ${id}`;
      expect(new Date(row!.updated_at).getTime()).toBeGreaterThan(Date.parse("2020-01-02T00:00:00Z"));
    });

    it("stamps a message with its arrival time when given, and with the save time otherwise", async () => {
      const id = await newConversation();
      const arrival = new Date("2026-07-10T18:00:00.000Z");
      const before = Date.now();

      await conversationStore.appendMessages(id, [{ role: "user", content: "Hi", createdAt: arrival }]);
      await conversationStore.appendMessages(id, [{ role: "assistant", content: "x" }]);

      const { messages } = await conversationStore.getMessages(id);
      expect(messages[0]!.createdAt).toEqual(arrival);
      expect(messages[1]!.createdAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    });

    // Postgres rejects a NUL byte in `text` (22021) and in a `jsonb` string (22P05).
    it("saves text and JSON carrying NUL bytes, without them", async () => {
      const id = await newConversation();
      const nul = String.fromCharCode(0);

      await conversationStore.appendMessages(id, [
        {
          role: "assistant",
          content: `prefix${nul}suffix`,
          steps: [{ index: 0, stepType: "tool-result", text: `prefix${nul}suffix`, toolCalls: [{ toolCallId: "c1", toolName: "x", args: { q: `with${nul}nul` } }], toolResults: [{ toolCallId: "c1", result: `ok${nul}` }], finishReason: "stop", durationMs: 1 }] as never,
          reasoning: [{ type: "text", text: `r${nul}` }] as never,
          attachments: [{ kind: "url", url: `https://x${nul}` }] as never,
          metadata: { note: `m${nul}` },
        },
      ]);

      const [message] = (await conversationStore.getMessages(id)).messages;
      expect(message!.content).toBe("prefixsuffix");
      expect(message!.steps![0]!.text).toBe("prefixsuffix");
      expect(message!.metadata).toEqual({ note: "m" });
      expect(JSON.stringify(message)).not.toContain("\\u0000");
    });
  });

  describe("getConversation", () => {
    it("returns the conversation with its agent, contact, display title and usage totals", async () => {
      const id = await newConversation("detail", { title: "Assistente: Orari", userIdentifier: "anna@example.com" });
      await addAiLog(id, "conversation", 1200, 0.004);
      await addAiLog(id, "service", 300, 0.001);

      const detail = await conversationStore.getConversation(id, scope);

      expect(detail).toMatchObject({
        conversationId: id,
        title: "Orari",
        userIdentifier: "anna@example.com",
        instanceId: agent,
        instanceName: "Cstore agent",
        totalTokens: 1500,
        conversationTokens: 1200,
        serviceTokens: 300,
      });
      expect(detail!.totalCost).toBeCloseTo(0.005, 6);
      expect(detail!.conversationCost).toBeCloseTo(0.004, 6);
      expect(detail!.serviceCost).toBeCloseTo(0.001, 6);
      expect(detail!.createdAt).toBeInstanceOf(Date);
    });

    it("returns zero usage and an empty title for a conversation without either", async () => {
      const detail = await conversationStore.getConversation(await newConversation(), scope);

      expect(detail).toMatchObject({ title: null, summary: null, messageCount: 0, totalTokens: 0, totalCost: 0 });
    });

    it("returns nothing for an unknown conversation", async () => {
      expect(await conversationStore.getConversation(convId("missing"), scope)).toBeNull();
    });
  });

  it("lists nothing for a caller whose scope reaches no workspace", async () => {
    await newConversation();

    expect(await conversationStore.listConversations({ scope: workspaceSetScope(new Set()) })).toEqual({ conversations: [], total: 0 });
  });

  describe("searchConversations", () => {
    it("returns a conversation matched by its id with no snippet, and its contact", async () => {
      const id = await newConversation("byid", { userIdentifier: "+393331234567" });

      const { conversations } = await conversationStore.searchConversations(id, { scope });

      expect(conversations.find((c) => c.conversationId === id)).toMatchObject({
        matchCount: 0,
        bestSnippet: "",
        userIdentifier: "+393331234567",
      });
    });

    it("treats LIKE wildcards in the query as literal characters", async () => {
      const literal = await newConversation("50%_x");
      const lookalike = await newConversation("50ab_x");

      const found = (await conversationStore.searchConversations("50%_x", { scope })).conversations.map((c) => c.conversationId);

      expect(found).toContain(literal);
      expect(found).not.toContain(lookalike);
    });
  });

  describe("getMessages", () => {
    it("pages through the messages oldest first, with the total", async () => {
      const id = await newConversation();
      await queryClient`
        INSERT INTO conversation_messages (conversation_id, role, content, created_at)
        SELECT ${id}, 'user', 'm' || n, '2026-03-01T10:00:00Z'::timestamptz + n * interval '1 minute'
        FROM generate_series(1, 55) n`;

      const first = await conversationStore.getMessages(id);
      const last = await conversationStore.getMessages(id, { limit: 10, offset: 50 });

      expect(first.total).toBe(55);
      expect(first.messages).toHaveLength(50);
      expect(first.messages[0]!.content).toBe("m1");
      expect(last.messages.map((m) => m.content)).toEqual(["m51", "m52", "m53", "m54", "m55"]);
    });

    it("returns an empty page for a conversation without messages", async () => {
      expect(await conversationStore.getMessages(convId("empty"))).toEqual({ messages: [], total: 0 });
    });

    it("returns a message's metadata and its attachments without the storage bucket", async () => {
      const id = await newConversation();
      const metadata = { originalKind: "audio", audio: { durationSec: 1.5, sttProvider: "openai" } };
      await conversationStore.appendMessages(id, [
        {
          role: "user",
          content: "foto",
          metadata,
          attachments: [{ type: "image", s3Key: "attachments/a/c/x.jpg", bucket: "acme-private", sizeBytes: 3 }] as never,
        },
      ]);

      const [message] = (await conversationStore.getMessages(id)).messages;

      expect(message!.metadata).toEqual(metadata);
      expect(message!.attachments).toEqual([{ type: "image", s3Key: "attachments/a/c/x.jpg", sizeBytes: 3 }]);
    });
  });

  describe("getRecentMessages", () => {
    it("returns the newest fifteen messages unless asked for another number, as role and content only", async () => {
      const id = await newConversation();
      await queryClient`
        INSERT INTO conversation_messages (conversation_id, role, content, created_at, metadata)
        SELECT ${id}, 'user', 'm' || n, '2026-03-01T10:00:00Z'::timestamptz + n * interval '1 minute', '{"k":1}'::jsonb
        FROM generate_series(1, 20) n`;

      const recent = await conversationStore.getRecentMessages(id);

      expect(recent).toHaveLength(15);
      expect(recent[0]).toEqual({ role: "user", content: "m6" });
      expect(await conversationStore.getRecentMessages(id, 5)).toHaveLength(5);
    });
  });

  it("gives the debug of a message without a trace or recorded runs an empty request path", async () => {
    const id = await newConversation();
    const messageId = crypto.randomUUID();
    await conversationStore.appendMessages(id, [{ id: messageId, role: "assistant", content: "x" }]);

    expect(await conversationStore.getMessageDebug(id, messageId)).toEqual({
      debugPayload: null,
      steps: null,
      content: "x",
      turn: null,
      summary: null,
      path: { turnStartedAt: null, replySentAt: null, deliveredText: null, intermediateText: null, modelCalls: [], hookRuns: [] },
    });
  });

  describe("deleteConversation", () => {
    it("removes the conversation with its messages, usage and state", async () => {
      const id = await newConversation();
      await conversationStore.appendMessages(id, [{ role: "user", content: "bye" }]);
      await addAiLog(id, "conversation", 10, 0.0001);
      await queryClient`INSERT INTO conversation_state (scope, scope_key, data) VALUES ('conversation', ${id}, '{}'::jsonb)`;

      expect(await conversationStore.deleteConversation(id, scope)).toBe(true);

      expect(await conversationStore.getConversation(id, scope)).toBeNull();
      expect(await count("conversation_messages", id)).toBe(0);
      expect(await count("ai_logs", id)).toBe(0);
      expect(await count("conversation_state", id)).toBe(0);
    });

    it("reports an unknown conversation as not deleted", async () => {
      expect(await conversationStore.deleteConversation(convId("missing"), scope)).toBe(false);
    });
  });

  describe("renameConversation", () => {
    it("moves the messages, usage and state to the new id", async () => {
      const id = await newConversation();
      const newId = `${id}-archived`;
      await conversationStore.appendMessages(id, [{ role: "user", content: "hi" }]);
      await addAiLog(id, "conversation", 10, 0.0001);
      await queryClient`INSERT INTO conversation_state (scope, scope_key, data) VALUES ('conversation', ${id}, '{}'::jsonb)`;

      expect(await conversationStore.renameConversation(id, newId, scope, "Archived")).toBe(true);

      expect(await conversationStore.getConversation(id, scope)).toBeNull();
      expect((await conversationStore.getConversation(newId, scope))?.title).toBe("Archived");
      expect(await count("conversation_messages", newId)).toBe(1);
      expect(await count("ai_logs", newId)).toBe(1);
      expect(await count("conversation_state", newId)).toBe(1);
      expect(await count("conversation_messages", id)).toBe(0);
    });

    it("changes only the title when the id stays the same", async () => {
      const id = await newConversation("same", { title: "Before" });
      await conversationStore.appendMessages(id, [{ role: "user", content: "hi" }]);

      expect(await conversationStore.renameConversation(id, id, scope, "Renamed only")).toBe(true);

      expect((await conversationStore.getConversation(id, scope))?.title).toBe("Renamed only");
      expect(await count("conversation_messages", id)).toBe(1);
    });

    it("reports an unknown conversation as not renamed", async () => {
      const id = convId("missing");

      expect(await conversationStore.renameConversation(id, id, scope, "x")).toBe(false);
    });
  });

  describe("replaceOldestMessages", () => {
    it("replaces the oldest messages with one summary message", async () => {
      const id = await newConversation();
      await queryClient`
        INSERT INTO conversation_messages (conversation_id, role, content, created_at)
        SELECT ${id}, 'user', 'm' || n, '2026-03-01T10:00:00Z'::timestamptz + n * interval '1 minute'
        FROM generate_series(1, 4) n`;

      await conversationStore.replaceOldestMessages(id, 2, "Summary here");

      const contents = (await conversationStore.getMessages(id, { limit: 10 })).messages.map((m) => m.content).sort();
      expect(contents).toEqual(["[Room history summary]\nSummary here", "m3", "m4"].sort());
    });

    it("writes no summary for a conversation without messages", async () => {
      const id = await newConversation();

      await conversationStore.replaceOldestMessages(id, 5, "unused");

      expect(await count("conversation_messages", id)).toBe(0);
    });
  });
});
