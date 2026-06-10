// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, or, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../database/client.js";
import { memories } from "../memory/schema.js";
import { knowledgeChunks } from "../knowledge/schema.js";
import { instances } from "../instances/schema.js";
import { embedMany, resolveEmbeddingContext } from "./index.js";
import { SUPPORTED_DIMS } from "./config.js";
import type { EmbeddingContext, EmbeddingDim, EmbeddingProvider } from "./types.js";

/** Embedding provider for a chat provider: bedrock → bedrock, everything else → openai. */
function embeddingProviderFor(provider: string | null | undefined): EmbeddingProvider {
  return provider === "bedrock" ? "bedrock" : "openai";
}

/**
 * Decide whether a provider/dim change requires a re-embed. True when:
 *  - the embedding provider changed (openai↔bedrock) → existing vectors are now
 *    in an incompatible space and must be regenerated, OR
 *  - the current embedding_dim is unsupported by the (new) embedding provider
 *    (e.g. bedrock + 1536) → the instance is otherwise unembeddable.
 * Anthropic↔OpenAI switches keep the same embedding provider (openai) → no-op.
 */
export function shouldReEmbedAfterSwitch(
  before: { provider?: string | null },
  after: { provider?: string | null; embeddingDim: number },
): boolean {
  const beforeEmb = embeddingProviderFor(before.provider);
  const afterEmb = embeddingProviderFor(after.provider);
  const providerChanged = beforeEmb !== afterEmb;
  const dimUnsupported = !SUPPORTED_DIMS[afterEmb].includes(after.embeddingDim as EmbeddingDim);
  return providerChanged || dimUnsupported;
}

const BATCH_SIZE = 50;
const MAX_FAILURE_BUDGET = BATCH_SIZE * 3;
const BACKOFF_MS = 500;

/**
 * A table carrying the dual `embedding`/`embedding_1024` vector columns that the
 * re-embed job migrates: currently `memories` and `knowledge_chunks`. Both share
 * the same column shape; only `touchUpdatedAt` differs (knowledge_chunks has no
 * `updated_at` column).
 */
interface ReEmbedTarget {
  readonly label: string;
  readonly table: PgTable;
  readonly idCol: PgColumn;
  readonly contentCol: PgColumn;
  readonly embeddingCol: PgColumn;
  readonly embedding1024Col: PgColumn;
  readonly providerCol: PgColumn;
  readonly instanceCol: PgColumn;
  readonly touchUpdatedAt: boolean;
}

const TARGETS: readonly ReEmbedTarget[] = [
  {
    label: "memories",
    table: memories,
    idCol: memories.id,
    contentCol: memories.content,
    embeddingCol: memories.embedding,
    embedding1024Col: memories.embedding1024,
    providerCol: memories.embeddingProvider,
    instanceCol: memories.instanceId,
    touchUpdatedAt: true,
  },
  {
    label: "knowledge_chunks",
    table: knowledgeChunks,
    idCol: knowledgeChunks.id,
    contentCol: knowledgeChunks.content,
    embeddingCol: knowledgeChunks.embedding,
    embedding1024Col: knowledgeChunks.embedding1024,
    providerCol: knowledgeChunks.embeddingProvider,
    instanceCol: knowledgeChunks.instanceId,
    touchUpdatedAt: false,
  },
];

/**
 * Extract a safe message from an unknown error. Bedrock's ValidationException
 * echoes the full input array (user content — potential PII) in its payload,
 * so we surface only `.message`, never the raw error object.
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

/** Rows still needing migration: legacy 1536, OR 1024 produced by another provider. */
function pendingPredicate(target: ReEmbedTarget, instanceId: string, targetProvider: EmbeddingProvider): SQL {
  return and(
    eq(target.instanceCol, instanceId),
    or(
      // legacy 1536 → migrate to 1024
      and(isNotNull(target.embeddingCol), isNull(target.embedding1024Col)),
      // already 1024 but produced by a different provider → re-embed in place
      and(
        isNotNull(target.embedding1024Col),
        sql`${target.providerCol} IS DISTINCT FROM ${targetProvider}`,
      ),
    ),
  )!;
}

/** Re-embed every pending row of a single target table. Idempotent, batched. */
async function migrateTarget(
  target: ReEmbedTarget,
  instanceId: string,
  forceCtx: EmbeddingContext,
): Promise<{ migrated: number; failed: number }> {
  const targetProvider = forceCtx.credentials.provider;
  let migrated = 0;
  let failed = 0;

  while (true) {
    const rows = await db
      .select({ id: target.idCol, content: target.contentCol })
      .from(target.table)
      .where(pendingPredicate(target, instanceId, targetProvider))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    try {
      const contents = rows.map((r) => r.content as string);
      const embeddings = await embedMany(contents, forceCtx);

      await db.transaction(async (tx) => {
        const whenClauses = sql.join(
          rows.map((r, i) => sql`WHEN ${r.id}::uuid THEN ${JSON.stringify(embeddings[i])}::vector`),
          sql` `,
        );
        const idList = sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `);
        const touch = target.touchUpdatedAt ? sql`, updated_at = NOW()` : sql``;
        await tx.execute(sql`
          UPDATE ${target.table}
          SET embedding = NULL,
              embedding_1024 = CASE id ${whenClauses} END,
              embedding_provider = ${targetProvider}${touch}
          WHERE id IN (${idList})
        `);
      });
      migrated += rows.length;
    } catch (err) {
      console.error(`[re-embed] ${target.label} batch failed for ${instanceId}: ${errorMessage(err)}`);
      failed += rows.length;
      if (failed >= MAX_FAILURE_BUDGET) break;
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }

  return { migrated, failed };
}

/** Count rows still holding a legacy 1536-dim vector for this instance. */
async function countLegacy(target: ReEmbedTarget, instanceId: string): Promise<number> {
  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(target.table)
    .where(and(eq(target.instanceCol, instanceId), isNotNull(target.embeddingCol)));
  return Number(remaining);
}

/**
 * Re-embed an instance's vectors into `embedding_1024` using its current provider,
 * across BOTH `memories` and `knowledge_chunks`, then flip the instance's
 * `embedding_dim` flag once NO legacy 1536-dim rows remain in EITHER table.
 *
 * Idempotent. Per-table candidates are EITHER:
 *  - legacy 1536-dim rows (non-null `embedding`, null `embedding_1024`), OR
 *  - same-dim 1024 rows produced by a DIFFERENT provider than the target
 *    (covers a same-dimension provider switch, e.g. OpenAI↔Bedrock at 1024d,
 *    where the old vectors would otherwise be cosine-compared against new-provider
 *    query vectors — two incompatible embedding spaces in one column).
 *
 * Gating the flip on both tables prevents the silent-degradation hole where an
 * instance with 0 memories but legacy knowledge chunks flips to 1024 immediately,
 * stranding those chunks' vectors in the now-inactive column (FTS-only search).
 */
export async function reEmbedInstance(instanceId: string): Promise<ReEmbedResult> {
  const ctx = await resolveEmbeddingContext(instanceId);
  const forceCtx: EmbeddingContext = { ...ctx, dimensions: 1024 as const };

  let migrated = 0;
  let failed = 0;
  for (const target of TARGETS) {
    const r = await migrateTarget(target, ctx.instanceId, forceCtx);
    migrated += r.migrated;
    failed += r.failed;
  }

  let legacyRemaining = 0;
  for (const target of TARGETS) {
    legacyRemaining += await countLegacy(target, ctx.instanceId);
  }

  let dimFlipped = false;
  if (legacyRemaining === 0) {
    await db.update(instances).set({ embeddingDim: 1024, updatedAt: new Date() }).where(eq(instances.id, ctx.instanceId));
    dimFlipped = true;
  }

  return { instanceId: ctx.instanceId, migrated, failed, dimFlipped };
}
