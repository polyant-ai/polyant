// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, or, isNotNull, isNull, sql } from "drizzle-orm";
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
 * Re-embed memories into embedding_1024 using the instance's current provider,
 * then flip the instance's embedding_dim flag once all legacy rows are migrated.
 * Idempotent. Candidates are EITHER:
 *  - legacy 1536-dim rows (non-null `embedding`, null `embedding_1024`), OR
 *  - same-dim 1024 rows produced by a DIFFERENT provider than the target
 *    (covers a same-dimension provider switch, e.g. OpenAI↔Bedrock at 1024d,
 *    where the old vectors would otherwise be cosine-compared against new-provider
 *    query vectors — two incompatible embedding spaces in one column).
 */
export async function reEmbedInstance(instanceId: string): Promise<ReEmbedResult> {
  const ctx = await resolveEmbeddingContext(instanceId);
  const forceCtx: EmbeddingContext = { ...ctx, dimensions: 1024 as const };
  const targetProvider = ctx.credentials.provider;

  let migrated = 0;
  let failed = 0;

  while (true) {
    const rows = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(
        and(
          eq(memories.instanceId, ctx.instanceId),
          or(
            // legacy 1536 → migrate to 1024
            and(isNotNull(memories.embedding), isNull(memories.embedding1024)),
            // already 1024 but produced by a different provider → re-embed in place
            and(
              isNotNull(memories.embedding1024),
              sql`${memories.embeddingProvider} IS DISTINCT FROM ${targetProvider}`,
            ),
          ),
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
