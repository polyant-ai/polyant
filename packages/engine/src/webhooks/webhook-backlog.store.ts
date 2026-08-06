// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, sql, desc, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { eventBacklog } from "./webhooks.schema.js";
import { asInstanceUuid, type InstanceUuid } from "../instances/identifiers.js";

export const BACKLOG_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
} as const;

export interface BacklogEvent {
  id: string;
  instanceId: InstanceUuid;
  eventDefinitionId: string;
  rawPayload: Record<string, unknown>;
  matchedAt: Date | null;
  status: string;
  completedAt: Date | null;
  reactNotes: string | null;
  createdAt: Date | null;
}

const BACKLOG_CAP = 100;

/**
 * Atomically insert an event only if the pending backlog is below the cap.
 * Returns the event ID if inserted, or null if the cap was reached.
 */
export async function insertEvent(
  instanceId: InstanceUuid,
  eventDefinitionId: string,
  rawPayload: Record<string, unknown>,
): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO event_backlog (agent_id, event_definition_id, raw_payload)
    SELECT ${instanceId}, ${eventDefinitionId}, ${JSON.stringify(rawPayload)}::jsonb
    WHERE (
      SELECT count(*) FROM event_backlog
      WHERE agent_id = ${instanceId} AND status = 'pending'
    ) < ${BACKLOG_CAP}
    RETURNING id
  `);
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Atomically list all pending events and transition them to PROCESSING in a single
 * transaction with FOR UPDATE row locks.  The atomic list+mark replaces the old
 * separate listPendingEvents() + markEventsProcessing() pair which had a TOCTOU
 * window between SELECT and UPDATE.
 */
export async function listAndMarkPendingEventsProcessing(instanceId: InstanceUuid): Promise<BacklogEvent[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(eventBacklog)
      .where(and(eq(eventBacklog.instanceId, instanceId), eq(eventBacklog.status, BACKLOG_STATUS.PENDING)))
      .orderBy(eventBacklog.createdAt)
      .for("update");
    const events = rows.map((r) => ({ ...r, instanceId: asInstanceUuid(r.instanceId) })) as BacklogEvent[];

    if (events.length > 0) {
      const ids = events.map((e) => e.id);
      await tx
        .update(eventBacklog)
        .set({ status: BACKLOG_STATUS.PROCESSING })
        .where(inArray(eventBacklog.id, ids));
    }

    return events;
  });
}

export async function countPendingEvents(instanceId: InstanceUuid): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventBacklog)
    .where(and(eq(eventBacklog.instanceId, instanceId), eq(eventBacklog.status, BACKLOG_STATUS.PENDING)));
  return rows[0].count;
}

export async function markEventsCompleted(eventIds: string[], notes?: string, instanceId?: InstanceUuid): Promise<void> {
  // Only update events that are still in PROCESSING status.
  // Events already marked COMPLETED by the mark_events_completed harness tool during the LLM
  // call must not be overwritten — that would clobber the tool's resolution notes.
  const conditions = [inArray(eventBacklog.id, eventIds), eq(eventBacklog.status, BACKLOG_STATUS.PROCESSING)];
  if (instanceId) conditions.push(eq(eventBacklog.instanceId, instanceId));

  const updated = await db
    .update(eventBacklog)
    .set({
      status: BACKLOG_STATUS.COMPLETED,
      completedAt: new Date(),
      reactNotes: notes ?? null,
    })
    .where(and(...conditions))
    .returning({ id: eventBacklog.id });

  if (eventIds.length > 0 && updated.length < eventIds.length) {
    console.debug(
      `[webhook-backlog] markEventsCompleted: ${updated.length}/${eventIds.length} rows updated ` +
      `(remaining were already COMPLETED by the harness tool)`,
    );
  }
}

/**
 * Reset all events stuck in PROCESSING back to PENDING.
 * Used at boot to recover from crashed/killed room cycles that left events
 * mid-transition (picked up by listAndMarkPendingEventsProcessing but never
 * completed).  A fresh engine has no running cycle by definition, so any row
 * in PROCESSING at boot is a zombie.
 */
export async function resetStuckProcessingEvents(): Promise<number> {
  const rows = await db
    .update(eventBacklog)
    .set({ status: BACKLOG_STATUS.PENDING })
    .where(eq(eventBacklog.status, BACKLOG_STATUS.PROCESSING))
    .returning({ id: eventBacklog.id });
  return rows.length;
}

export async function countPendingByInstance(): Promise<Map<InstanceUuid, number>> {
  const rows = await db
    .select({ instanceId: eventBacklog.instanceId, count: sql<number>`count(*)::int` })
    .from(eventBacklog)
    .where(eq(eventBacklog.status, BACKLOG_STATUS.PENDING))
    .groupBy(eventBacklog.instanceId);
  return new Map(rows.map((r) => [asInstanceUuid(r.instanceId), r.count]));
}

export async function listBacklog(
  instanceId: InstanceUuid,
  opts: { status?: string; limit?: number; offset?: number },
): Promise<{ events: BacklogEvent[]; total: number }> {
  const conditions = [eq(eventBacklog.instanceId, instanceId)];
  if (opts.status) conditions.push(eq(eventBacklog.status, opts.status));

  const [events, countResult] = await Promise.all([
    db
      .select()
      .from(eventBacklog)
      .where(and(...conditions))
      .orderBy(desc(eventBacklog.createdAt))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventBacklog)
      .where(and(...conditions)),
  ]);

  return { events: (events as Array<typeof events[number]>).map((r) => ({ ...r, instanceId: asInstanceUuid(r.instanceId) })) as BacklogEvent[], total: countResult[0].count };
}
