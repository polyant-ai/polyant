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

import { describe, it, expect, afterAll } from "vitest";
import { loadConversationState, flushConversationState } from "./state.store.js";

const CID = "itest:state-store:merge";

/** Probe the DB once (bounded), so the suite skips instead of hanging/failing
 *  when there is no migrated Postgres reachable. */
async function dbReachable(): Promise<boolean> {
  try {
    await Promise.race([
      loadConversationState("__itest_probe__"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("db probe timeout")), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const DB_AVAILABLE = await dbReachable();

describe("conversation state store (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Best-effort cleanup so re-runs start from an empty blob.
    await flushConversationState(CID, "itest", {}, ["a", "b", "c", "_channel"]).catch(() => {});
  });

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
