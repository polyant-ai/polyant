// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instanceHooks } from "./hooks.schema.js";
import { resolveInstanceId } from "../instances/resolve-instance-id.js";
import type { InstanceSlug, InstanceUuid } from "../instances/identifiers.js";
import { TtlCache } from "../utils/ttl-cache.js";
import type {
  HookActionConfig,
  HookActionType,
  HookEvent,
  InstanceHookRow,
} from "./hook-types.js";

/** Cached enabled-hooks lookup, keyed by instance slug (the pipeline's id). */
const cache = new TtlCache<string, Map<HookEvent, InstanceHookRow[]>>({
  maxSize: 200,
  ttlMs: 30_000,
});

export function invalidateHooksCache(slug: InstanceSlug): void {
  cache.delete(slug);
}

function toRow(r: typeof instanceHooks.$inferSelect): InstanceHookRow {
  return {
    id: r.id,
    instanceId: r.instanceId,
    event: r.event as HookEvent,
    actionType: r.actionType as HookActionType,
    actionConfig: r.actionConfig,
    enabled: r.enabled,
    position: r.position,
    timeoutMs: r.timeoutMs,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export interface CreateHookInput {
  event: HookEvent;
  actionType: HookActionType;
  actionConfig: HookActionConfig;
  enabled?: boolean;
  position?: number;
  timeoutMs?: number;
}

export async function listHooks(instanceId: InstanceUuid): Promise<InstanceHookRow[]> {
  const rows = await db
    .select()
    .from(instanceHooks)
    .where(eq(instanceHooks.instanceId, instanceId))
    .orderBy(asc(instanceHooks.event), asc(instanceHooks.position), asc(instanceHooks.createdAt));
  return rows.map(toRow);
}

export async function createHook(
  instanceId: InstanceUuid,
  input: CreateHookInput,
): Promise<InstanceHookRow> {
  const rows = await db
    .insert(instanceHooks)
    .values({
      instanceId,
      event: input.event,
      actionType: input.actionType,
      actionConfig: input.actionConfig,
      enabled: input.enabled ?? true,
      position: input.position ?? 0,
      timeoutMs: input.timeoutMs ?? 10_000,
    })
    .returning();
  return toRow(rows[0]);
}

export async function updateHook(
  instanceId: InstanceUuid,
  hookId: string,
  patch: Partial<CreateHookInput>,
): Promise<InstanceHookRow | undefined> {
  const rows = await db
    .update(instanceHooks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(instanceHooks.id, hookId), eq(instanceHooks.instanceId, instanceId)))
    .returning();
  return rows[0] ? toRow(rows[0]) : undefined;
}

export async function deleteHook(instanceId: InstanceUuid, hookId: string): Promise<boolean> {
  const rows = await db
    .delete(instanceHooks)
    .where(and(eq(instanceHooks.id, hookId), eq(instanceHooks.instanceId, instanceId)))
    .returning({ id: instanceHooks.id });
  return rows.length > 0;
}

/**
 * Enabled hooks for one (instance, event), ordered by position then createdAt.
 * One query per instance per TTL window — all events are loaded and grouped.
 * Unknown slugs resolve to an empty list (cached, so they cost one lookup).
 */
export async function getEnabledHooks(
  slug: InstanceSlug,
  event: HookEvent,
): Promise<InstanceHookRow[]> {
  let byEvent = cache.get(slug);
  if (!byEvent) {
    byEvent = new Map();
    const instanceId = await resolveInstanceId(slug);
    if (instanceId) {
      const rows = await db
        .select()
        .from(instanceHooks)
        .where(and(eq(instanceHooks.instanceId, instanceId), eq(instanceHooks.enabled, true)))
        .orderBy(asc(instanceHooks.position), asc(instanceHooks.createdAt));
      for (const row of rows.map(toRow)) {
        const list = byEvent.get(row.event) ?? [];
        list.push(row);
        byEvent.set(row.event, list);
      }
    }
    cache.set(slug, byEvent);
  }
  return byEvent.get(event) ?? [];
}
