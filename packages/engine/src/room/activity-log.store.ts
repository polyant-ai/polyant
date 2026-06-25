// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, lte, sql, desc, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { roomActivityLog } from "./room.schema.js";
import { asAgentUuid, type AgentUuid } from "../instances/identifiers.js";

export interface ActivityEntry {
  id: string;
  agentId: AgentUuid;
  logDate: string;
  logType: string;
  content: string;
  eventCount: number;
}

export async function appendDailyLog(agentId: AgentUuid, content: string, eventCount: number): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  await db
    .insert(roomActivityLog)
    .values({ agentId, logDate: today, logType: "daily", content, eventCount })
    .onConflictDoUpdate({
      target: [roomActivityLog.agentId, roomActivityLog.logDate, roomActivityLog.logType],
      set: {
        content: sql`${roomActivityLog.content} || E'\n\n' || ${content}`,
        eventCount: sql`${roomActivityLog.eventCount} + ${eventCount}`,
      },
    });
}

export async function listActivity(
  agentId: AgentUuid,
  opts: { logType?: string; limit?: number; offset?: number },
): Promise<ActivityEntry[]> {
  const conditions = [eq(roomActivityLog.agentId, agentId)];
  if (opts.logType) conditions.push(eq(roomActivityLog.logType, opts.logType));

  const rows = await db
    .select()
    .from(roomActivityLog)
    .where(and(...conditions))
    .orderBy(desc(roomActivityLog.logDate))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  return rows.map((r) => ({ ...r, agentId: asAgentUuid(r.agentId) })) as ActivityEntry[];
}

export async function compactActivityLog(agentId: AgentUuid): Promise<void> {
  const now = new Date();

  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  await db
    .delete(roomActivityLog)
    .where(
      and(
        eq(roomActivityLog.agentId, agentId),
        eq(roomActivityLog.logType, "monthly"),
        lte(roomActivityLog.logDate, twelveMonthsAgo.toISOString().split("T")[0]),
      ),
    );

  const fourWeeksAgo = new Date(now);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  await compactEntries(agentId, "weekly", fourWeeksAgo, "monthly");

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  await compactEntries(agentId, "daily", sevenDaysAgo, "weekly");
}

async function compactEntries(
  agentId: AgentUuid,
  fromType: string,
  olderThan: Date,
  toType: string,
): Promise<void> {
  const cutoff = olderThan.toISOString().split("T")[0];

  await db.transaction(async (tx) => {
    const oldEntries = await tx
      .select()
      .from(roomActivityLog)
      .where(
        and(
          eq(roomActivityLog.agentId, agentId),
          eq(roomActivityLog.logType, fromType),
          lte(roomActivityLog.logDate, cutoff),
        ),
      )
      .orderBy(roomActivityLog.logDate);

    if (oldEntries.length === 0) return;

    const mergedContent = oldEntries.map((e) => `[${e.logDate}] ${e.content}`).join("\n");
    const totalEvents = oldEntries.reduce((sum, e) => sum + e.eventCount, 0);
    const periodDate = oldEntries[0].logDate;

    await tx.insert(roomActivityLog).values({
      agentId,
      logDate: periodDate,
      logType: toType,
      content: mergedContent,
      eventCount: totalEvents,
    });

    const idsToDelete = oldEntries.map((e) => e.id);
    await tx.delete(roomActivityLog).where(inArray(roomActivityLog.id, idsToDelete));
  });
}
