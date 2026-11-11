// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * getMessageDebug against a real Postgres: a turn's request path is what is
 * filed under its message — model calls, hook runs, the trace's t0 and send
 * time — and a turn recorded before the request path has none. The raw
 * exchanges of a call are read only through the message they belong to.
 *
 * Self-skips when no migrated database is reachable.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { conversationStore } from "./store.js";
import { readExchanges } from "../request-path/request-path.store.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { allTenantsScope } from "../authz/scope-filter.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const CID = `itest:message-debug:${Date.now()}`;
const OTHER_CID = `${CID}:other`;
const SLUG = asInstanceSlug("itest-message-debug");
const OLD = "11111111-0000-4000-8000-000000000001";
const NEW = "11111111-0000-4000-8000-000000000002";
const AGENT_CALL = "22222222-0000-4000-8000-000000000001";
const HOOK_CALL = "22222222-0000-4000-8000-000000000002";
const HOOK_RUN = "33333333-0000-4000-8000-000000000001";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();

async function message(id: string | null, role: string, second: number) {
  await db.execute(sql`
    INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES (COALESCE(${id}::uuid, gen_random_uuid()), ${CID}, ${role}, ${role}, ${at(second)})
  `);
}

async function call(id: string, model: string, second: number, filed: { messageId?: string; callType?: string; purpose?: string; originName?: string; parentRef?: string }) {
  await db.execute(sql`
    INSERT INTO ai_logs (id, provider, model, tier, prompt_tokens, completion_tokens, total_tokens,
                         estimated_cost_usd, duration_ms, conversation_id, call_type, purpose,
                         message_id, started_at, origin_name, parent_ref, created_at)
    VALUES (${id}::uuid, 'openai', ${model}, 'standard', 10, 5, 15, 0.001, 100, ${CID},
            ${filed.callType ?? "conversation"}, ${filed.purpose ?? null}, ${filed.messageId ?? null}::uuid,
            ${at(second)}, ${filed.originName ?? null}, ${filed.parentRef ?? null}, ${at(second + 1)})
  `);
}

describe("getMessageDebug (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await db.execute(sql`DELETE FROM model_exchanges WHERE conversation_id IN (${CID}, ${OTHER_CID})`);
    await conversationStore.deleteConversation(CID, allTenantsScope("integration test cleanup")).catch(() => {});
  });

  it.skipIf(!DB_AVAILABLE)("reads a turn's request path by its message, and an older turn's from its trace", async () => {
    await conversationStore.ensureConversation(CID, SLUG);
    await message(null, "user", 0);
    // Before the request path: a call with no message id, in the turn's time window.
    await call("22222222-0000-4000-8000-000000000009", "legacy", 1, {});
    await message(OLD, "assistant", 3);
    await message(null, "user", 10);
    await call(HOOK_CALL, "hook-model", 11, { messageId: NEW, callType: "service", purpose: "hook", originName: "classify", parentRef: HOOK_RUN });
    await call(AGENT_CALL, "answer", 12, { messageId: NEW });
    await message(NEW, "assistant", 14);
    await db.execute(sql`
      INSERT INTO hook_executions (id, instance_id, conversation_id, hook_id, event, action_type, tool_name,
                                   success, duration_ms, message_id, started_at)
      VALUES (${HOOK_RUN}::uuid, ${SLUG}, ${CID}, gen_random_uuid(), 'message_received', 'function', 'classify',
              true, 40, ${NEW}::uuid, ${at(11)})
    `);
    await db.execute(sql`
      INSERT INTO pipeline_traces (conversation_id, message_id, instance_id, channel, total_ms, is_streaming,
                                   turn_started_at, reply_sent_at, delivered_text, intermediate_text)
      VALUES (${CID}, ${NEW}, ${SLUG}, 'web', 4000, true, ${at(10)}, ${at(14)}, 'step one

assistant', null)
    `);

    await db.execute(sql`
      INSERT INTO pipeline_traces (conversation_id, message_id, instance_id, channel, total_ms, llm_call_ms, is_streaming,
                                   model, provider, prompt_tokens, completion_tokens, created_at)
      VALUES (${CID}, ${OLD}, ${SLUG}, 'web', 2000, 1500, false, 'old-model', 'openai', 30, 7, ${at(3)})
    `);

    // The call in the old turn's window is not taken: the agent's call comes from the trace.
    const old = await conversationStore.getMessageDebug(CID, OLD);
    expect(old?.path.modelCalls.map((c) => [c.id, c.callType, c.model, c.promptTokens, c.durationMs, c.startedAt])).toEqual([
      [OLD, "conversation", "old-model", 30, 1500, null],
    ]);
    expect(old?.path.hookRuns).toEqual([]);
    expect(old?.path.turnStartedAt).toBe(at(1));
    expect(old?.path.replySentAt).toBe(at(3));

    const turn = await conversationStore.getMessageDebug(CID, NEW);
    expect(turn?.path.modelCalls.map((c) => [c.model, c.originName, c.parentRef])).toEqual([
      ["hook-model", "classify", HOOK_RUN],
      ["answer", null, null],
    ]);
    expect(turn?.path.hookRuns.map((h) => [h.id, h.name])).toEqual([[HOOK_RUN, "classify"]]);
    expect(turn?.path.turnStartedAt).toBe(at(10));
    expect(turn?.path.replySentAt).toBe(at(14));
    expect(turn?.path.deliveredText).toBe("step one\n\nassistant");
    expect(turn?.content).toBe("assistant");
  });

  it.skipIf(!DB_AVAILABLE)("reads a call's raw exchanges only through its own message and conversation", async () => {
    await db.execute(sql`
      INSERT INTO model_exchanges (ai_log_id, message_id, conversation_id, step_index, attempt, status, request, response)
      VALUES (${AGENT_CALL}::uuid, ${NEW}::uuid, ${CID}, 0, 1, 200, '{"messages":[]}'::jsonb, '{"content":[]}'::jsonb),
             (${AGENT_CALL}::uuid, ${NEW}::uuid, ${CID}, 1, 1, 429, '{"messages":[1]}'::jsonb, '{"error":"rate"}'::jsonb)
    `);
    const exchanges = await readExchanges(CID, NEW, AGENT_CALL);
    expect(exchanges.map((e) => [e.stepIndex, e.status])).toEqual([[0, 200], [1, 429]]);

    const turn = await conversationStore.getMessageDebug(CID, NEW);
    expect(turn?.path.modelCalls.find((c) => c.id === AGENT_CALL)?.exchangeCount).toBe(2);

    expect(await readExchanges(OTHER_CID, NEW, AGENT_CALL)).toEqual([]);
    expect(await readExchanges(CID, OLD, AGENT_CALL)).toEqual([]);
  });
});
