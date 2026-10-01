// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-conversation counters of migration conversation_message_counters (message_count,
 * user_message_count, last_message_at) against a real Postgres: appendMessages
 * keeps them, room compaction adjusts them, and they always equal what a COUNT
 * over conversation_messages would say — the readers (lists, analytics) trust
 * them instead of counting.
 *
 * Self-skips when no migrated database is reachable.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { conversationStore } from "./store.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { allTenantsScope } from "../authz/scope-filter.js";
import { readdirSync, readFileSync } from "node:fs";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const CID = `itest:counters:${Date.now()}`;
const SLUG = asInstanceSlug("itest-counters");

async function counters() {
  const rows = (await db.execute(sql`
    SELECT c.message_count, c.user_message_count, c.last_message_at,
           (SELECT count(*)::int FROM conversation_messages cm WHERE cm.conversation_id = c.conversation_id) AS actual,
           (SELECT count(*)::int FROM conversation_messages cm WHERE cm.conversation_id = c.conversation_id AND cm.role = 'user') AS actual_user,
           (SELECT max(created_at) FROM conversation_messages cm WHERE cm.conversation_id = c.conversation_id) AS actual_last
    FROM conversations c WHERE c.conversation_id = ${CID}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

function expectConsistent(r: Record<string, unknown>) {
  expect(r.message_count).toBe(r.actual);
  expect(r.user_message_count).toBe(r.actual_user);
  expect(new Date(r.last_message_at as string).getTime()).toBe(new Date(r.actual_last as string).getTime());
}

describe("conversation message counters (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await conversationStore.deleteConversation(CID, allTenantsScope("integration test cleanup")).catch(() => {});
  });

  it.skipIf(!DB_AVAILABLE)("keeps the counters equal to the messages through appends and compaction", async () => {
    await conversationStore.ensureConversation(CID, SLUG);
    expect(await counters()).toMatchObject({ message_count: 0, user_message_count: 0, last_message_at: null });

    // A turn: database-stamped timestamps.
    await conversationStore.appendMessages(CID, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    let r = await counters();
    expect(r).toMatchObject({ message_count: 2, user_message_count: 1 });
    expectConsistent(r);

    // Imported history with explicit, older timestamps: last_message_at must not go back.
    const before = new Date(r.last_message_at as string);
    await conversationStore.appendMessages(CID, [
      { role: "user", content: "old question", createdAt: new Date("2020-01-01T00:00:00Z") },
      { role: "assistant", content: "old answer", createdAt: new Date("2020-01-01T00:00:01Z") },
      { role: "user", content: "older still", createdAt: new Date("2019-06-01T00:00:00Z") },
    ]);
    r = await counters();
    expect(r).toMatchObject({ message_count: 5, user_message_count: 3 });
    expect(new Date(r.last_message_at as string).getTime()).toBe(before.getTime());
    expectConsistent(r);

    // Room compaction: the three oldest (two of them user) become one summary.
    await conversationStore.replaceOldestMessages(CID, 3, "summary");
    r = await counters();
    expect(r).toMatchObject({ message_count: 3, user_message_count: 1 });
    expectConsistent(r);

    // The readers report the counter.
    const conv = await conversationStore.getConversation(CID, allTenantsScope("integration test read"));
    expect(conv?.messageCount).toBe(3);
  });

  it.skipIf(!DB_AVAILABLE)("rebuilds the counters from history with the migration's own backfill", async () => {
    await db.execute(sql`UPDATE conversations SET message_count = 0, user_message_count = 0, last_message_at = NULL WHERE conversation_id = ${CID}`);
    // The UPDATE statement exactly as the migration runs it. Found by name, not
    // number: editions number their migrations differently.
    const dir = new URL("../database/migrations/", import.meta.url);
    const file = readdirSync(dir).find((f) => f.endsWith("_conversation_message_counters.sql"));
    expect(file).toBeDefined();
    const migration = readFileSync(new URL(file!, dir), "utf8");
    const backfill = migration.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => /^(--[^\n]*\n)*UPDATE "conversations"/.test(s));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(backfill!));

    const r = await counters();
    expect(r.message_count).toBeGreaterThan(0);
    expectConsistent(r);
  });
});
