// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../database/client.js";

/** How long a delivery key is remembered: past it, the same key is a new event. */
export const DELIVERY_KEY_TTL = "24 hours";

/**
 * Claim the first delivery of an event its sender keyed. True for the first
 * copy, false for every redelivery of the same key to the same source, on any
 * process. The key is stored as a digest, so an id the sender chose (which may
 * name a person or a record) never lands in the table. A key past its window is
 * claimed again in place; the daily housekeeping drops the rest of the expired
 * keys (`deleteExpiredWebhookDeliveries`).
 */
export async function claimWebhookDelivery(eventSourceId: string, idempotencyKey: string): Promise<boolean> {
  const digest = keyDigest(idempotencyKey);
  const rows = await db.execute<{ key_digest: string }>(sql`
    INSERT INTO webhook_deliveries (event_source_id, key_digest)
    VALUES (${eventSourceId}, ${digest})
    ON CONFLICT (event_source_id, key_digest) DO UPDATE SET received_at = now()
      WHERE webhook_deliveries.received_at < now() - ${DELIVERY_KEY_TTL}::interval
    RETURNING key_digest
  `);
  return rows.length > 0;
}

/**
 * Give a claimed key back, for an event that was dropped without being
 * processed: a redelivery of it, once the cause is fixed, is a new delivery.
 */
export async function releaseWebhookDelivery(eventSourceId: string, idempotencyKey: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM webhook_deliveries
    WHERE event_source_id = ${eventSourceId} AND key_digest = ${keyDigest(idempotencyKey)}
  `);
}

function keyDigest(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}
