// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * getMessageDebug against a real Postgres: which model calls belong to a turn.
 * `ai_logs` carries no message id, so the turn is the span from the user
 * message that opened it to the next user message, and this pins that span.
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

const DB_AVAILABLE = await resolveDatabaseAvailability();
const CID = `itest:message-debug:${Date.now()}`;
const SLUG = asInstanceSlug("itest-message-debug");
const FIRST = "11111111-0000-4000-8000-000000000001";
const SECOND = "11111111-0000-4000-8000-000000000002";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();

async function message(id: string | null, role: string, second: number) {
  await db.execute(sql`
    INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES (COALESCE(${id}::uuid, gen_random_uuid()), ${CID}, ${role}, ${role}, ${at(second)})
  `);
}

async function call(model: string, callType: string, second: number) {
  await db.execute(sql`
    INSERT INTO ai_logs (provider, model, tier, prompt_tokens, completion_tokens, total_tokens,
                         estimated_cost_usd, duration_ms, conversation_id, call_type, created_at)
    VALUES ('openai', ${model}, 'standard', 10, 5, 15, 0.001, 100, ${CID}, ${callType}, ${at(second)})
  `);
}

describe("getMessageDebug (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await db.execute(sql`DELETE FROM ai_logs WHERE conversation_id = ${CID}`);
    await db.execute(sql`DELETE FROM pipeline_traces WHERE conversation_id = ${CID}`);
    await conversationStore.deleteConversation(CID, allTenantsScope("integration test cleanup")).catch(() => {});
  });

  it.skipIf(!DB_AVAILABLE)("gives each turn the model calls from its user message to the next one", async () => {
    await conversationStore.ensureConversation(CID, SLUG);
    await message(null, "user", 0);
    await call("answer-1", "conversation", 2);
    await message(FIRST, "assistant", 3);
    // A post-response call of the first turn, after its answer was saved.
    await call("summary-1", "service", 4);
    await message(null, "user", 10);
    await call("answer-2", "conversation", 12);
    await message(SECOND, "assistant", 13);
    await db.execute(sql`
      INSERT INTO pipeline_traces (conversation_id, message_id, instance_id, channel, total_ms, is_streaming,
                                   stt_provider, stt_duration_ms, audio_duration_sec)
      VALUES (${CID}, ${SECOND}, ${SLUG}, 'whatsapp', 900, false, 'deepgram', 320, 4.5)
    `);

    const first = await conversationStore.getMessageDebug(CID, FIRST);
    expect(first?.modelCalls.map((c) => c.model)).toEqual(["answer-1", "summary-1"]);
    expect(first?.turn).toBeNull();

    const second = await conversationStore.getMessageDebug(CID, SECOND);
    expect(second?.modelCalls.map((c) => c.model)).toEqual(["answer-2"]);
    expect(second?.turn).toEqual({
      channel: "whatsapp",
      streaming: false,
      speechToText: { provider: "deepgram", durationMs: 320, audioDurationSec: 4.5 },
    });
  });
});
