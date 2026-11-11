// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { isForeignKeyViolation } from "../utils/db-errors.js";
import { userFavoriteAgents } from "./favorite-agents.schema.js";

/**
 * A person's starred agents. Every function takes the user id and nothing else
 * names whose rows are read or written, so no caller can reach another user's
 * stars.
 */

/** Stars one person may hold. Far above any sidebar's use; a bound on a row count a client drives. */
export const FAVORITE_AGENTS_LIMIT = 100;

export type AddFavoriteResult = "added" | "already" | "limit" | "unknown-agent";

/** The agent ids this person starred, oldest first. */
export async function listFavoriteAgentIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ instanceId: userFavoriteAgents.instanceId })
    .from(userFavoriteAgents)
    .where(eq(userFavoriteAgents.userId, userId))
    .orderBy(asc(userFavoriteAgents.createdAt), asc(userFavoriteAgents.instanceId));
  return rows.map((row) => row.instanceId);
}

/**
 * Star an agent. Starring it again is a no-op. The row is written only while
 * the person holds fewer than the limit, in the same statement that counts them.
 */
export async function addFavoriteAgent(userId: string, instanceId: string): Promise<AddFavoriteResult> {
  try {
    const inserted = await db.execute(sql`
      INSERT INTO ${userFavoriteAgents} ("user_id", "instance_id")
      SELECT ${userId}::uuid, ${instanceId}::uuid
      WHERE (SELECT count(*) FROM ${userFavoriteAgents} WHERE "user_id" = ${userId}::uuid) < ${FAVORITE_AGENTS_LIMIT}
      ON CONFLICT DO NOTHING
      RETURNING "instance_id"
    `);
    if (inserted.length > 0) return "added";
  } catch (err) {
    // The agent id names no agent (or the user is gone): the foreign key refuses it.
    if (isForeignKeyViolation(err)) return "unknown-agent";
    throw err;
  }
  // Nothing written: either the star was already there or the limit is reached.
  const existing = await db
    .select({ instanceId: userFavoriteAgents.instanceId })
    .from(userFavoriteAgents)
    .where(and(eq(userFavoriteAgents.userId, userId), eq(userFavoriteAgents.instanceId, instanceId)))
    .limit(1);
  return existing.length > 0 ? "already" : "limit";
}

/** Take the star off. Removing one that is not there is a no-op. */
export async function removeFavoriteAgent(userId: string, instanceId: string): Promise<void> {
  await db
    .delete(userFavoriteAgents)
    .where(and(eq(userFavoriteAgents.userId, userId), eq(userFavoriteAgents.instanceId, instanceId)));
}
