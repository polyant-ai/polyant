// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { memories } from "../memory/schema.js";
import { instances } from "../instances/schema.js";
import { embedMany, resolveEmbeddingContext } from "./index.js";
import type { EmbeddingContext } from "./types.js";

const BATCH_SIZE = 50;
const MAX_FAILURE_BUDGET = BATCH_SIZE * 3;
const BACKOFF_MS = 500;

/**
 * Extract a safe message from an unknown error. Bedrock's ValidationException
 * echoes the full input array (user memory content — potential PII) in its
 * payload, so we surface only `.message`, never the raw error object.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

export interface ReEmbedResult {
  readonly instanceId: string;
  readonly migrated: number;
  readonly failed: number;
  readonly dimFlipped: boolean;
}

/**
 * Re-embed every memory still on the legacy 1536-dim column into embedding_1024,
 * then flip the instance's embedding_dim flag once all rows are migrated.
 * Idempotent: candidates are rows with non-null `embedding` and null `embedding_1024`.
 */
export async function reEmbedInstance(instanceId: string): Promise<ReEmbedResult> {
  const ctx = await resolveEmbeddingContext(instanceId);
  const forceCtx: EmbeddingContext = { ...ctx, dimensions: 1024 as const };

  let migrated = 0;
  let failed = 0;

  while (true) {
    const rows = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(
        and(
          eq(memories.instanceId, ctx.instanceId),
          isNotNull(memories.embedding),
          isNull(memories.embedding1024),
        ),
      )
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    try {
      const contents = rows.map((r) => r.content);
      const embeddings = await embedMany(contents, forceCtx);

      await db.transaction(async (tx) => {
        const whenClauses = sql.join(
          rows.map((r, i) => sql`WHEN ${r.id}::uuid THEN ${JSON.stringify(embeddings[i])}::vector`),
          sql` `,
        );
        const idList = sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `);
        await tx.execute(sql`
          UPDATE memories
          SET embedding = NULL,
              embedding_1024 = CASE id ${whenClauses} END,
              embedding_provider = ${forceCtx.credentials.provider},
              updated_at = NOW()
          WHERE id IN (${idList})
        `);
      });
      migrated += rows.length;
    } catch (err) {
      console.error(`[re-embed] batch failed for ${ctx.instanceId}: ${errorMessage(err)}`);
      failed += rows.length;
      if (failed >= MAX_FAILURE_BUDGET) break;
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }

  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(memories)
    .where(and(eq(memories.instanceId, ctx.instanceId), isNotNull(memories.embedding)));

  let dimFlipped = false;
  if (Number(remaining) === 0) {
    await db.update(instances).set({ embeddingDim: 1024, updatedAt: new Date() }).where(eq(instances.id, ctx.instanceId));
    dimFlipped = true;
  }

  return { instanceId: ctx.instanceId, migrated, failed, dimFlipped };
}
