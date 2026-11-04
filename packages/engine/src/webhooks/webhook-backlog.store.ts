// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, sql, desc, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { eventBacklog } from "./webhooks.schema.js";
import { WORK_LEASE_TTL_MS } from "../background/work-lease.js";
import { asInstanceUuid, type InstanceUuid } from "../instances/identifiers.js";
import { createLogger } from "../utils/create-logger.js";

const log = createLogger();

export const BACKLOG_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
} as const;

export interface BacklogEvent {
  id: string;
  instanceId: InstanceUuid;
  /** Null for a message from the Room's contact (see `queueHumanMessage`). */
  eventDefinitionId: string | null;
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
  eventDefinitionId: string | null,
  rawPayload: Record<string, unknown>,
): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO event_backlog (instance_id, event_definition_id, raw_payload)
    SELECT ${instanceId}, ${eventDefinitionId}, ${JSON.stringify(rawPayload)}::jsonb
    WHERE (
      SELECT count(*) FROM event_backlog
      WHERE instance_id = ${instanceId} AND status = 'pending'
    ) < ${BACKLOG_CAP}
    RETURNING id
  `);
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Queue a message from the Room's contact for the Room's next cycle, as an event
 * with no definition. A message that arrives while a cycle runs waits for the next
 * one instead of being dropped, and survives a restart like any other event.
 */
export function queueHumanMessage(instanceId: InstanceUuid, text: string): Promise<string | null> {
  return insertEvent(instanceId, null, { text });
}

/** The work-lease key a Room's cycle holds; the events it claims carry the lease's owner. */
const ROOM_LEASE_PREFIX = "room:";
export function roomLeaseKey(instanceId: InstanceUuid): string {
  return `${ROOM_LEASE_PREFIX}${instanceId}`;
}

/**
 * Atomically list all pending events and transition them to PROCESSING in a single
 * transaction with FOR UPDATE row locks, naming `owner` (the Room's lease owner) as
 * their claimant.  The atomic list+mark replaces the old separate
 * listPendingEvents() + markEventsProcessing() pair which had a TOCTOU window
 * between SELECT and UPDATE.
 */
export async function listAndMarkPendingEventsProcessing(instanceId: InstanceUuid, owner: string): Promise<BacklogEvent[]> {
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
        .set({ status: BACKLOG_STATUS.PROCESSING, claimedBy: owner, claimedAt: sql`now()` })
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

export async function markEventsCompleted(
  eventIds: string[],
  notes?: string,
  instanceId?: InstanceUuid,
  owner?: string,
): Promise<void> {
  // Only update events that are still in PROCESSING status.
  // Events already marked COMPLETED by the mark_events_completed harness tool during the LLM
  // call must not be overwritten — that would clobber the tool's resolution notes.
  const conditions = [inArray(eventBacklog.id, eventIds), eq(eventBacklog.status, BACKLOG_STATUS.PROCESSING)];
  if (instanceId) conditions.push(eq(eventBacklog.instanceId, instanceId));
  // A cycle completes only what it claimed: once its lease expired and the events went
  // back to pending, another cycle owns them.
  if (owner) conditions.push(eq(eventBacklog.claimedBy, owner));

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
    log.debug(
      "webhook-backlog",
      `markEventsCompleted: ${updated.length}/${eventIds.length} rows updated ` +
      `(remaining were already COMPLETED by the harness tool)`,
    );
  }
}

/**
 * Put back to pending every event in PROCESSING whose claimant holds no live Room
 * lease: its cycle ended without completing it, or its process is gone. Runs on
 * every tick of every replica; an event a live cycle holds is never touched, so a
 * replica starting during a deploy does not hand another replica's work to a
 * second cycle.
 *
 * A process of the previous release claims events without an owner or a lease, so
 * whether its cycle is still running cannot be told. Such an event is stamped the
 * first time a tick sees it and put back only once it has waited a lease's
 * lifetime, which a cycle does not outlast.
 */
export async function requeueEventsWithoutLiveLease(): Promise<number> {
  await db.execute(sql`
    UPDATE event_backlog SET claimed_at = now()
    WHERE status = ${BACKLOG_STATUS.PROCESSING} AND claimed_by IS NULL AND claimed_at IS NULL
  `);
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE event_backlog e SET status = ${BACKLOG_STATUS.PENDING}, claimed_by = NULL, claimed_at = NULL
    WHERE e.status = ${BACKLOG_STATUS.PROCESSING}
      AND CASE WHEN e.claimed_by IS NULL
        THEN e.claimed_at < now() - make_interval(secs => ${WORK_LEASE_TTL_MS / 1000})
        ELSE NOT EXISTS (
          SELECT 1 FROM work_leases l
          WHERE l.key = ${ROOM_LEASE_PREFIX} || e.instance_id::text
            AND l.owner = e.claimed_by
            AND l.expires_at > now()
        )
      END
    RETURNING e.id
  `);
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
