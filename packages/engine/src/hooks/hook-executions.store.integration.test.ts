// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the hook_executions telemetry store. Requires a
 * migrated Postgres; self-skips otherwise so a bare `npm test` stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { hookExecutions } from "./hooks.schema.js";
import {
  recordHookExecution,
  listHookExecutions,
} from "./hook-executions.store.js";
import { asInstanceSlug } from "../instances/identifiers.js";

const CID = "itest:hook-executions:conv";
const HOOK_ID = "00000000-0000-4000-8000-000000000001";

async function dbReachable(): Promise<boolean> {
  try {
    await Promise.race([
      listHookExecutions("__itest_probe__"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("db probe timeout")), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const DB_AVAILABLE = await dbReachable();

describe("hook executions store (integration)", () => {
  beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await db.delete(hookExecutions).where(eq(hookExecutions.conversationId, CID));
  });

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await db.delete(hookExecutions).where(eq(hookExecutions.conversationId, CID));
  });

  it.skipIf(!DB_AVAILABLE)(
    "should_record_and_list_executions_in_chronological_order",
    async () => {
      await recordHookExecution({
        instanceId: asInstanceSlug("itest-hooks"),
        conversationId: CID,
        hookId: HOOK_ID,
        event: "message_received",
        actionType: "tool",
        toolName: "lookup",
        success: true,
        durationMs: 42,
        args: { query: "+39" },
        result: '{"ok":true}',
      });
      await recordHookExecution({
        instanceId: asInstanceSlug("itest-hooks"),
        conversationId: CID,
        hookId: HOOK_ID,
        event: "response_generated",
        actionType: "tool",
        toolName: "notify",
        success: false,
        error: "boom",
        durationMs: 7,
      });

      const rows = await listHookExecutions(CID);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        event: "message_received",
        toolName: "lookup",
        success: true,
        durationMs: 42,
        error: null,
        args: { query: "+39" },
        result: '{"ok":true}',
      });
      expect(rows[1]).toMatchObject({
        event: "response_generated",
        toolName: "notify",
        success: false,
        error: "boom",
        args: null,
        result: null,
      });
      expect(rows[0].createdAt).toBeInstanceOf(Date);

      // other conversations see nothing
      expect(await listHookExecutions("itest:hook-executions:other")).toEqual([]);
    },
  );
});
