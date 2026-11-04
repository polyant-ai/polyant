// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The history a turn sends the model: the conversation's newest messages, in
 * the order they were written, and only that conversation's. A mocked query
 * returns its prepared rows whatever it asks, so only a real database tells an
 * "oldest first" or an unfiltered read apart.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { conversationStore } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = `itest-recent-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const MINE = `${MARKER}-mine`;
const OTHER = `${MARKER}-other`;

describe.skipIf(!DB_AVAILABLE)("recent conversation history (integration)", () => {
  beforeAll(async () => {
    // Six messages a minute apart, alternating roles; the other conversation's are newer still.
    await queryClient`
      INSERT INTO conversation_messages (conversation_id, role, content, created_at)
      SELECT ${MINE}, CASE WHEN n % 2 = 1 THEN 'user' ELSE 'assistant' END, 'message ' || n,
             '2026-03-01T10:00:00Z'::timestamptz + n * interval '1 minute'
      FROM generate_series(1, 6) n`;
    await queryClient`
      INSERT INTO conversation_messages (conversation_id, role, content, created_at)
      SELECT ${OTHER}, 'user', 'other ' || n, '2026-03-01T11:00:00Z'::timestamptz + n * interval '1 minute'
      FROM generate_series(1, 3) n`;
  });

  afterAll(async () => {
    await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${MARKER + "%"}`;
  });

  it("returns the newest messages of the conversation, oldest of them first", async () => {
    expect(await conversationStore.getRecentMessages(MINE, 3)).toEqual([
      { role: "assistant", content: "message 4" },
      { role: "user", content: "message 5" },
      { role: "assistant", content: "message 6" },
    ]);
  });

  it("returns the same window with the stored detail of each message", async () => {
    const rows = await conversationStore.getRecentMessageRows(MINE, 3);

    expect(rows.map((r) => r.content)).toEqual(["message 4", "message 5", "message 6"]);
  });
});
