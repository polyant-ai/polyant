// SPDX-License-Identifier: AGPL-3.0-or-later

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../database/client.js";
import { conversationMessages, conversations } from "../conversations/schema.js";
import { getAllSecrets } from "../instances/secrets.store.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import { describeAgentS3Failure, resolveAgentS3 } from "./agent-s3.js";
import { attachmentsLog } from "./attachments-logger.js";

/**
 * Deleting the stored copies of a conversation's attachments when its rows go.
 *
 * Deleting a conversation or an agent removed every row and left the files the
 * user sent in the agent's bucket for ever. This takes them along, in two steps,
 * because both things it needs disappear with the rows: the keys live on
 * `conversation_messages.attachments`, and the credentials that reach the bucket
 * are the agent's secrets, which cascade with the agent. So:
 *
 *   const cleanup = await prepareAttachmentCleanup(slug, target); // before
 *   ... delete the rows ...
 *   void cleanup();                                                // after
 *
 * Best effort on both sides. Neither step throws, so a bucket that refuses the
 * delete, revoked credentials or an S3 outage never stand in the way of the
 * database delete; a failure is logged with the agent slug and a count, never a
 * key (a key carries the conversation id, and that can carry a phone number).
 *
 * The recorded keys, rather than listing the bucket: a renamed conversation's
 * files keep their original key, only `s3:DeleteObject` is needed, and an object
 * anything else wrote to the same bucket is never touched — it lives outside
 * `attachments/`.
 */

export type AttachmentCleanup = () => Promise<void>;

/** Which conversations of the agent to clean up after. */
export type AttachmentCleanupTarget =
  | { readonly conversationIds: readonly string[] }
  | { readonly allConversations: true };

const NOTHING: AttachmentCleanup = async () => {};

/** S3 DeleteObjects takes at most 1000 keys per request. */
const DELETE_BATCH = 1000;
/** Conversation ids bound per lookup, far below PostgreSQL's parameter limit. */
const LOOKUP_BATCH = 1000;

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

/**
 * Every stored key of the target conversations that belongs to this agent,
 * grouped by the bucket it was written to. Files stored before the bucket was
 * recorded are filed under `undefined`: the agent's current bucket is the only
 * guess there is for them.
 */
async function storedKeys(
  instanceId: InstanceSlug,
  target: AttachmentCleanupTarget,
): Promise<Map<string | undefined, string[]>> {
  const rows: Array<{ attachments: Array<{ s3Key?: unknown; bucket?: unknown }> | null }> = [];
  if ("allConversations" in target) {
    rows.push(
      ...(await db
        .select({ attachments: conversationMessages.attachments })
        .from(conversationMessages)
        .where(
          and(
            isNotNull(conversationMessages.attachments),
            inArray(
              conversationMessages.conversationId,
              db
                .select({ conversationId: conversations.conversationId })
                .from(conversations)
                .where(eq(conversations.instanceId, instanceId)),
            ),
          ),
        )),
    );
  } else {
    for (let i = 0; i < target.conversationIds.length; i += LOOKUP_BATCH) {
      const ids = target.conversationIds.slice(i, i + LOOKUP_BATCH);
      rows.push(
        ...(await db
          .select({ attachments: conversationMessages.attachments })
          .from(conversationMessages)
          .where(and(isNotNull(conversationMessages.attachments), inArray(conversationMessages.conversationId, [...ids])))),
      );
    }
  }

  // Only this agent's own prefix: the bucket is this agent's, and a key naming
  // another agent is not one this cleanup has any business deleting.
  const prefix = `attachments/${instanceId}/`;
  const byBucket = new Map<string | undefined, Set<string>>();
  for (const row of rows) {
    for (const att of row.attachments ?? []) {
      if (typeof att?.s3Key !== "string" || !att.s3Key.startsWith(prefix)) continue;
      const bucket = typeof att.bucket === "string" && att.bucket ? att.bucket : undefined;
      const keys = byBucket.get(bucket) ?? new Set<string>();
      keys.add(att.s3Key);
      byBucket.set(bucket, keys);
    }
  }
  return new Map([...byBucket].map(([bucket, keys]) => [bucket, [...keys]]));
}

/**
 * Collect what a later delete of the target conversations' attachments needs.
 * Call it BEFORE deleting the rows; run the returned function after they are
 * gone. Never throws; an agent without storage gets a function that does nothing.
 */
export async function prepareAttachmentCleanup(
  instanceId: InstanceSlug,
  target: AttachmentCleanupTarget,
): Promise<AttachmentCleanup> {
  if ("conversationIds" in target && target.conversationIds.length === 0) return NOTHING;
  try {
    const resolution = resolveAgentS3(await getAllSecrets(instanceId));
    const stored = await storedKeys(instanceId, target);
    const total = [...stored.values()].reduce((n, keys) => n + keys.length, 0);
    if (total === 0) return NOTHING;
    // Files were stored, but the engine can no longer reach the bucket: they
    // stay behind, and the operator is told why rather than left to find them.
    if (!resolution.ok) {
      attachmentsLog.warn(
        "Cleanup",
        `${instanceId}: ${total} stored attachment(s) left in the bucket — ${describeAgentS3Failure(resolution)}`,
      );
      return NOTHING;
    }
    const { client, bucket: currentBucket } = resolution.config;

    // A file is deleted from the bucket it was written to. The operator can
    // change the agent's bucket, and S3 reports no error for a key that is not
    // there, so deleting an old file from the new bucket would count it as gone
    // while it stays where it was. A bucket these credentials cannot reach
    // answers with an error, which is counted as a failure.
    const byBucket = new Map<string, string[]>();
    for (const [bucket, keys] of stored) {
      const target = bucket ?? currentBucket;
      byBucket.set(target, [...(byBucket.get(target) ?? []), ...keys]);
    }

    return async () => {
      let failed = 0;
      for (const [bucket, keys] of byBucket) {
        for (let i = 0; i < keys.length; i += DELETE_BATCH) {
          const batch = keys.slice(i, i + DELETE_BATCH);
          try {
            const result = await client.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
              }),
            );
            failed += result.Errors?.length ?? 0;
          } catch (err) {
            failed += batch.length;
            attachmentsLog.warn("Cleanup", `${instanceId}: deleting stored attachments failed (${errorName(err)})`);
          }
        }
      }
      if (failed > 0) {
        attachmentsLog.warn(
          "Cleanup",
          `${instanceId}: ${failed} of ${total} stored attachments were not deleted from the agent's bucket`,
        );
      } else {
        attachmentsLog.info("Cleanup", `${instanceId}: deleted ${total} stored attachments`);
      }
    };
  } catch (err) {
    attachmentsLog.warn(
      "Cleanup",
      `${instanceId}: stored attachments could not be looked up for deletion (${errorName(err)})`,
    );
    return NOTHING;
  }
}

