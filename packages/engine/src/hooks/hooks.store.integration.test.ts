// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the instance_hooks store. Requires a migrated Postgres
 * (docker compose up -d postgres && npm run db:migrate); self-skips otherwise
 * so a bare `npm test` stays green.
 *
 * It used to skip by returning early INSIDE each test body, which vitest counts
 * as PASSED, not skipped — so with no database this file reported two green
 * ticks and the `↓` marker that makes an absent tier visible never appeared. And
 * the setup swallowed every error in a bare `catch`, so a renamed column, a
 * missing default workspace or a new NOT NULL produced the same two green ticks.
 *
 * Now: `describe.skipIf` reports honestly, the shared probe decides (and fails
 * loudly under CI_REQUIRE_DB), and setup errors are NOT caught — when there is a
 * database, a failure there is a real defect and must say so.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { workspaces } from "../organizations/organization.schema.js";
import {
  listHooks,
  createHook,
  updateHook,
  deleteHook,
  getEnabledHooks,
  invalidateHooksCache,
} from "./hooks.store.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "../instances/identifiers.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const SLUG = "itest-hooks-store";
let instanceUuid: InstanceUuid | undefined;

async function setupInstance(): Promise<InstanceUuid> {
    const [ws] = await Promise.race([
      db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("db timeout")), 3000)),
    ]);
    const rows = await Promise.race([
      db
        .insert(instances)
        .values({ slug: SLUG, name: "itest hooks", workspaceId: ws.id })
        .onConflictDoNothing()
        .returning({ id: instances.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("db timeout")), 3000)),
    ]);
    if (rows.length > 0) return asInstanceUuid(rows[0].id);
    const existing = await db
      .select({ id: instances.id })
      .from(instances)
      .where(eq(instances.slug, SLUG))
      .limit(1);
    if (!existing[0]) {
      throw new Error(`could not create or find the test instance "${SLUG}"`);
    }
    return asInstanceUuid(existing[0].id);
}

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  instanceUuid = await setupInstance();
});

afterAll(async () => {
  if (!instanceUuid) return;
  await db.delete(instances).where(eq(instances.id, instanceUuid)); // cascades to hooks
});

describe.skipIf(!DB_AVAILABLE)("hooks store (integration)", () => {
  it("should_crud_and_order_hooks", { timeout: 15000 }, async () => {
    const uuid = instanceUuid!;

    // create two hooks on the same event, out-of-order positions
    const second = await createHook(uuid, {
      event: "conversation_start",
      actionType: "function",
      actionConfig: { functionName: "toolB" },
      position: 2,
    });
    const first = await createHook(uuid, {
      event: "conversation_start",
      actionType: "function",
      actionConfig: { functionName: "toolA" },
      position: 1,
    });
    const disabled = await createHook(uuid, {
      event: "conversation_start",
      actionType: "function",
      actionConfig: { functionName: "toolC" },
      enabled: false,
    });

    // list returns all three
    const all = await listHooks(uuid);
    expect(all.map((h) => h.id).sort()).toEqual([first.id, second.id, disabled.id].sort());

    // cached read returns only enabled, ordered by position
    invalidateHooksCache(asInstanceSlug(SLUG));
    const enabled = await getEnabledHooks(asInstanceSlug(SLUG), "conversation_start");
    expect(enabled.map((h) => h.actionConfig.functionName)).toEqual(["toolA", "toolB"]);

    // other events are empty
    expect(await getEnabledHooks(asInstanceSlug(SLUG), "response_sent")).toEqual([]);

    // update flips enabled and patches config
    const updated = await updateHook(uuid, disabled.id, { enabled: true, timeoutMs: 5000 });
    expect(updated?.enabled).toBe(true);
    expect(updated?.timeoutMs).toBe(5000);

    // cache invalidation makes the new hook visible
    invalidateHooksCache(asInstanceSlug(SLUG));
    const enabledAfter = await getEnabledHooks(asInstanceSlug(SLUG), "conversation_start");
    expect(enabledAfter).toHaveLength(3);

    // delete is instance-scoped
    expect(await deleteHook(uuid, first.id)).toBe(true);
    expect(await deleteHook(uuid, first.id)).toBe(false);
  });

  it("should_return_empty_when_slug_unknown", async () => {
    expect(await getEnabledHooks(asInstanceSlug("itest-hooks-nope"), "message_received")).toEqual([]);
  });
});
