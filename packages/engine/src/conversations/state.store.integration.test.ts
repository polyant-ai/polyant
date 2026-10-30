// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the conversation state store DB layer.
 *
 * Unlike the unit tests (which mock the DB), this exercises the real `||` /
 * `- key` JSONB merge SQL against a live Postgres with migrations applied.
 *
 * Self-skips when no migrated database is reachable (so a bare `npm test`
 * without a DB stays green). Run it for real with a database up:
 *   docker compose up -d postgres && npm run db:migrate && npm run test:integration
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { conversationState } from "./schema.js";
import { loadConversationState, flushConversationState } from "./state.store.js";
import { ConversationStateBuffer } from "./state.buffer.js";

const CID = "itest:state-store:merge";
const CID_CHANNEL = "itest:state-store:channel";

/** The row's `updated_at`, which every upsert of the state moves. */
async function updatedAt(conversationId: string): Promise<Date | undefined> {
  const rows = await db
    .select({ at: conversationState.updatedAt })
    .from(conversationState)
    .where(and(eq(conversationState.scope, "conversation"), eq(conversationState.scopeKey, conversationId)))
    .limit(1);
  return rows[0]?.at;
}


const DB_AVAILABLE = await resolveDatabaseAvailability();

describe("conversation state store (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Best-effort cleanup so re-runs start from an empty blob.
    await flushConversationState(CID, "itest", {}, ["a", "b", "c", "_channel"]).catch(() => {});
    await flushConversationState(CID_CHANNEL, "itest", {}, ["_channel"]).catch(() => {});
  });

  it.skipIf(!DB_AVAILABLE)(
    "returns the channel identity in jsonb key order, and a turn with the same identity does not rewrite the row",
    async () => {
      const identity = { type: "telegram", id: "42", userName: "Mario" };
      await flushConversationState(CID_CHANNEL, "itest", { _channel: identity }, []);
      const loaded = await loadConversationState(CID_CHANNEL);
      // jsonb sorts keys by length, then bytes: never the order the identity was built in.
      expect(Object.keys(loaded._channel as object)).toEqual(["id", "type", "userName"]);

      const before = await updatedAt(CID_CHANNEL);
      expect(before).toBeInstanceOf(Date);
      await new Promise((resolve) => setTimeout(resolve, 5)); // a rewrite would move updated_at at least this far
      const buf = new ConversationStateBuffer(CID_CHANNEL, "itest", loaded);
      buf.seedChannel({ ...identity });
      await buf.flush();
      expect(await updatedAt(CID_CHANNEL)).toEqual(before);
    },
  );

  it.skipIf(!DB_AVAILABLE)(
    "merges, overwrites and removes keys across flushes (per-key, not whole-blob)",
    async () => {
      // Fresh / cleaned conversation → empty blob.
      expect(await loadConversationState(CID)).toEqual({});

      // Insert path: a brand-new row stores exactly the dirty set.
      await flushConversationState(CID, "itest", { a: 1, _channel: { type: "whatsapp", id: "+39" } }, []);
      expect(await loadConversationState(CID)).toEqual({ a: 1, _channel: { type: "whatsapp", id: "+39" } });

      // Merge path: a different key is added without clobbering existing keys.
      await flushConversationState(CID, "itest", { b: 2 }, []);
      expect(await loadConversationState(CID)).toEqual({ a: 1, b: 2, _channel: { type: "whatsapp", id: "+39" } });

      // Overwrite path: same key replaced, others preserved.
      await flushConversationState(CID, "itest", { a: 9 }, []);
      expect(await loadConversationState(CID)).toMatchObject({ a: 9, b: 2 });

      // Combined set + remove in a single flush.
      await flushConversationState(CID, "itest", { c: 3 }, ["a", "b"]);
      const final = await loadConversationState(CID);
      expect(final).toMatchObject({ c: 3 });
      expect(final).not.toHaveProperty("a");
      expect(final).not.toHaveProperty("b");
    },
  );
});
