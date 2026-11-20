// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Messages saved in one write share the transaction's created_at; the reads put
 * them in the order they were saved, by `seq`. The rows here are inserted in the
 * opposite order of their seq, so a read that ignored seq would come back in
 * insertion order and fail.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { conversationStore } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const CONVERSATION = `itest-order-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!DB_AVAILABLE)("message order on a shared created_at (integration)", () => {
  beforeAll(async () => {
    const [{ first }] = await queryClient<{ first: string }[]>`
      SELECT nextval('conversation_messages_seq_seq')::text AS first`;
    const seq = Number(first);
    await queryClient`SELECT nextval('conversation_messages_seq_seq')`;
    // The reply goes into the table first, with the higher seq.
    await queryClient`
      INSERT INTO conversation_messages (conversation_id, role, content, created_at, seq)
      VALUES (${CONVERSATION}, 'assistant', 'reply', '2026-03-01T10:00:00Z', ${seq + 1})`;
    await queryClient`
      INSERT INTO conversation_messages (conversation_id, role, content, created_at, seq)
      VALUES (${CONVERSATION}, 'user', 'question', '2026-03-01T10:00:00Z', ${seq})`;
  });

  afterAll(async () => {
    await queryClient`DELETE FROM conversation_messages WHERE conversation_id = ${CONVERSATION}`;
  });

  it("lists the transcript question first, and reply first when newest first", async () => {
    const asc = await conversationStore.getMessages(CONVERSATION, { order: "asc" });
    const desc = await conversationStore.getMessages(CONVERSATION, { order: "desc" });

    expect(asc.messages.map((m) => m.content)).toEqual(["question", "reply"]);
    expect(desc.messages.map((m) => m.content)).toEqual(["reply", "question"]);
  });

  it("sends the model the question before the reply", async () => {
    expect(await conversationStore.getRecentMessages(CONVERSATION, 2)).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "reply" },
    ]);
    const window = await conversationStore.getHistoryWindow(CONVERSATION, { after: null, limit: 2, withSteps: false });
    expect(window.map((r) => r.content)).toEqual(["question", "reply"]);
  });
});
