// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { agentHooks } from "./hooks.schema.js";
import { resolveAgentId } from "../instances/resolve-agent-id.js";
import type { AgentSlug, AgentUuid } from "../instances/identifiers.js";
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

export function invalidateHooksCache(slug: AgentSlug): void {
  cache.delete(slug);
}

function toRow(r: typeof agentHooks.$inferSelect): InstanceHookRow {
  return {
    id: r.id,
    agentId: r.agentId,
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

export async function listHooks(agentId: AgentUuid): Promise<InstanceHookRow[]> {
  const rows = await db
    .select()
    .from(agentHooks)
    .where(eq(agentHooks.agentId, agentId))
    .orderBy(asc(agentHooks.event), asc(agentHooks.position), asc(agentHooks.createdAt));
  return rows.map(toRow);
}

export async function createHook(
  agentId: AgentUuid,
  input: CreateHookInput,
): Promise<InstanceHookRow> {
  const rows = await db
    .insert(agentHooks)
    .values({
      agentId,
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
  agentId: AgentUuid,
  hookId: string,
  patch: Partial<CreateHookInput>,
): Promise<InstanceHookRow | undefined> {
  const rows = await db
    .update(agentHooks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(agentHooks.id, hookId), eq(agentHooks.agentId, agentId)))
    .returning();
  return rows[0] ? toRow(rows[0]) : undefined;
}

export async function deleteHook(agentId: AgentUuid, hookId: string): Promise<boolean> {
  const rows = await db
    .delete(agentHooks)
    .where(and(eq(agentHooks.id, hookId), eq(agentHooks.agentId, agentId)))
    .returning({ id: agentHooks.id });
  return rows.length > 0;
}

/**
 * Enabled hooks for one (instance, event), ordered by position then createdAt.
 * One query per instance per TTL window — all events are loaded and grouped.
 * Unknown slugs resolve to an empty list (cached, so they cost one lookup).
 */
export async function getEnabledHooks(
  slug: AgentSlug,
  event: HookEvent,
): Promise<InstanceHookRow[]> {
  let byEvent = cache.get(slug);
  if (!byEvent) {
    byEvent = new Map();
    const agentId = await resolveAgentId(slug);
    if (agentId) {
      const rows = await db
        .select()
        .from(agentHooks)
        .where(and(eq(agentHooks.agentId, agentId), eq(agentHooks.enabled, true)))
        .orderBy(asc(agentHooks.position), asc(agentHooks.createdAt));
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
