// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the instance_hooks store. Requires a migrated Postgres
 * (docker compose up -d postgres && npm run db:migrate); self-skips otherwise
 * so a bare `npm test` stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { agents } from "../instances/schema.js";
import { workspaces } from "../organizations/organization.schema.js";
import {
  listHooks,
  createHook,
  updateHook,
  deleteHook,
  getEnabledHooks,
  invalidateHooksCache,
} from "./hooks.store.js";
import { asAgentSlug, asAgentUuid, type AgentUuid } from "../instances/identifiers.js";

const SLUG = "itest-hooks-store";
let instanceUuid: AgentUuid | undefined;

async function setupInstance(): Promise<AgentUuid | undefined> {
  try {
    const [ws] = await Promise.race([
      db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("db timeout")), 3000)),
    ]);
    const rows = await Promise.race([
      db
        .insert(agents)
        .values({ slug: SLUG, name: "itest hooks", workspaceId: ws.id })
        .onConflictDoNothing()
        .returning({ id: agents.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("db timeout")), 3000)),
    ]);
    if (rows.length > 0) return asAgentUuid(rows[0].id);
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, SLUG))
      .limit(1);
    return existing[0] ? asAgentUuid(existing[0].id) : undefined;
  } catch {
    return undefined;
  }
}

beforeAll(async () => {
  instanceUuid = await setupInstance();
});

afterAll(async () => {
  if (!instanceUuid) return;
  await db.delete(agents).where(eq(agents.id, instanceUuid)); // cascades to hooks
});

describe("hooks store (integration)", () => {
  it("should_crud_and_order_hooks_when_db_available", { timeout: 15000 }, async () => {
    if (!instanceUuid) return; // no DB — skip silently
    const uuid = instanceUuid;

    // create two hooks on the same event, out-of-order positions
    const second = await createHook(uuid, {
      event: "conversation_start",
      actionType: "tool",
      actionConfig: { toolName: "toolB", args: {} },
      position: 2,
    });
    const first = await createHook(uuid, {
      event: "conversation_start",
      actionType: "tool",
      actionConfig: { toolName: "toolA", args: { q: "{{channel.id}}" } },
      position: 1,
    });
    const disabled = await createHook(uuid, {
      event: "conversation_start",
      actionType: "tool",
      actionConfig: { toolName: "toolC", args: {} },
      enabled: false,
    });

    // list returns all three
    const all = await listHooks(uuid);
    expect(all.map((h) => h.id).sort()).toEqual([first.id, second.id, disabled.id].sort());

    // cached read returns only enabled, ordered by position
    invalidateHooksCache(asAgentSlug(SLUG));
    const enabled = await getEnabledHooks(asAgentSlug(SLUG), "conversation_start");
    expect(enabled.map((h) => h.actionConfig.toolName)).toEqual(["toolA", "toolB"]);

    // other events are empty
    expect(await getEnabledHooks(asAgentSlug(SLUG), "response_sent")).toEqual([]);

    // update flips enabled and patches config
    const updated = await updateHook(uuid, disabled.id, { enabled: true, timeoutMs: 5000 });
    expect(updated?.enabled).toBe(true);
    expect(updated?.timeoutMs).toBe(5000);

    // cache invalidation makes the new hook visible
    invalidateHooksCache(asAgentSlug(SLUG));
    const enabledAfter = await getEnabledHooks(asAgentSlug(SLUG), "conversation_start");
    expect(enabledAfter).toHaveLength(3);

    // delete is instance-scoped
    expect(await deleteHook(uuid, first.id)).toBe(true);
    expect(await deleteHook(uuid, first.id)).toBe(false);
  });

  it("should_return_empty_when_slug_unknown", async () => {
    if (!instanceUuid) return;
    expect(await getEnabledHooks(asAgentSlug("itest-hooks-nope"), "message_received")).toEqual([]);
  });
});
