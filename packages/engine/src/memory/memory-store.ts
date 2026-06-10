// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, desc, sql, gt, and, ilike, isNotNull, count as drizzleCount } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions";
import { db } from "../database/client.js";
import { memories } from "./schema.js";
import { config } from "../config.js";
import type { EmbeddingDim, EmbeddingProvider } from "../embeddings-gateway/types.js";
import { vectorColumnValues } from "../embeddings-gateway/dim-columns.js";

// ---- Types ----

export interface MemoryRecord {
  id: string;
  instanceId: string;
  content: string;
  category: string;
  importance: number;
  sourceConversationId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface InsertMemoryInput {
  instanceId: string;
  content: string;
  category?: string;
  importance?: number;
  sourceConversationId?: string;
  embedding: number[];
  /** Dimension of `embedding` — chooses DB column. */
  dimensions: EmbeddingDim;
  /** Provider that produced the embedding. Stored as `embedding_provider`. */
  provider: EmbeddingProvider;
}

export type MemoryEvent = "ADD" | "UPDATE";

export interface UpsertResult {
  id: string;
  content: string;
  event: MemoryEvent;
}

// ---- Helpers ----

/** Escape special LIKE pattern characters so user input is treated as literal text. */
function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/** Pick the active Drizzle column based on dim. */
function activeEmbeddingColumn(dim: EmbeddingDim) {
  return dim === 1024 ? memories.embedding1024 : memories.embedding;
}

// ---- Constants ----

/** Cosine similarity threshold for deduplication, sourced from Zod-validated
 *  config (env var `DEDUP_SIMILARITY_THRESHOLD`, default 0.90). If an existing
 *  memory has similarity > this value, treat as duplicate and update. */
const DEDUP_SIMILARITY_THRESHOLD = config.memory.dedupSimilarityThreshold;

// ---- Store functions ----

/** PostgreSQL serialization_failure SQLSTATE. Emitted when SERIALIZABLE detects a conflict. */
const SERIALIZATION_FAILURE = "40001";
const MAX_UPSERT_RETRIES = 3;

function isSerializationFailure(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as Error & { code: string }).code === SERIALIZATION_FAILURE;
}

async function runUpsertMemoryTx(input: InsertMemoryInput): Promise<UpsertResult> {
  // SERIALIZABLE isolation prevents phantom reads: two concurrent calls cannot both
  // miss the similarity check and both insert, creating duplicates.
  return db.transaction(async (tx) => {
    const activeCol = activeEmbeddingColumn(input.dimensions);
    const vectorCols = vectorColumnValues(input.dimensions, input.embedding);
    const distance = cosineDistance(activeCol, input.embedding);

    // Find the closest existing memory for this user with similarity above threshold
    const [closest] = await tx
      .select({
        id: memories.id,
        content: memories.content,
        distance: sql<number>`${distance}`,
      })
      .from(memories)
      .where(and(
        eq(memories.instanceId, input.instanceId),
        gt(sql<number>`1 - (${distance})`, DEDUP_SIMILARITY_THRESHOLD),
      ))
      .orderBy(distance)
      .limit(1);

    if (closest) {
      // Update existing memory
      await tx
        .update(memories)
        .set({
          content: input.content,
          category: input.category ?? "general",
          importance: input.importance ?? 5,
          ...vectorCols,
          embeddingProvider: input.provider,
          updatedAt: new Date(),
        })
        .where(eq(memories.id, closest.id));

      return { id: closest.id, content: input.content, event: "UPDATE" as const };
    }

    // No duplicate found: insert new
    const [inserted] = await tx
      .insert(memories)
      .values({
        instanceId: input.instanceId,
        content: input.content,
        category: input.category ?? "general",
        importance: input.importance ?? 5,
        sourceConversationId: input.sourceConversationId ?? null,
        ...vectorCols,
        embeddingProvider: input.provider,
      })
      .returning({ id: memories.id });

    return { id: inserted.id, content: input.content, event: "ADD" as const };
  }, { isolationLevel: "serializable" });
}

/**
 * Insert a new memory, or update an existing one if a near-duplicate is found.
 * Deduplication: if any memory for this user has cosine similarity > threshold,
 * the closest match is updated (content replaced, updatedAt refreshed).
 *
 * Retries on `serialization_failure` (40001) with exponential backoff (10/20/40ms).
 * SERIALIZABLE isolation aborts conflicting transactions; the caller should not see
 * the 40001 under normal contention.
 */
export async function upsertMemory(input: InsertMemoryInput): Promise<UpsertResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_UPSERT_RETRIES; attempt++) {
    try {
      return await runUpsertMemoryTx(input);
    } catch (err) {
      lastErr = err;
      if (!isSerializationFailure(err)) throw err;
      if (attempt < MAX_UPSERT_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

/**
 * Semantic search: find the N closest memories by cosine similarity.
 */
export async function searchByVector(
  queryEmbedding: number[],
  instanceId: string,
  limit = 10,
  dimensions: EmbeddingDim,
): Promise<Array<MemoryRecord & { similarity: number }>> {
  const activeCol = activeEmbeddingColumn(dimensions);
  const distance = cosineDistance(activeCol, queryEmbedding);

  const rows = await db
    .select({
      id: memories.id,
      instanceId: memories.instanceId,
      content: memories.content,
      category: memories.category,
      importance: memories.importance,
      sourceConversationId: memories.sourceConversationId,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      distance: sql<number>`${distance}`,
    })
    .from(memories)
    // Exclude rows whose active vector column is NULL: their cosine distance is
    // NULL → `1 - NULL` = NaN, which would otherwise leak into search results
    // (and to the model via the memory tools) when fewer than `limit` rows match.
    .where(and(eq(memories.instanceId, instanceId), isNotNull(activeCol)))
    .orderBy(distance)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    instanceId: r.instanceId,
    content: r.content,
    category: r.category,
    importance: r.importance,
    sourceConversationId: r.sourceConversationId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    similarity: 1 - r.distance,
  }));
}

/**
 * Get all memories for a user, ordered by most recent first.
 */
export async function getAllMemories(instanceId: string): Promise<MemoryRecord[]> {
  return db
    .select({
      id: memories.id,
      instanceId: memories.instanceId,
      content: memories.content,
      category: memories.category,
      importance: memories.importance,
      sourceConversationId: memories.sourceConversationId,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(eq(memories.instanceId, instanceId))
    .orderBy(desc(memories.updatedAt));
}

/**
 * Search memories with pagination, text filtering (ILIKE), and category filtering.
 */
export async function searchMemories(
  instanceId: string,
  opts: { search?: string; category?: string; limit?: number; offset?: number } = {},
): Promise<{ memories: MemoryRecord[]; total: number }> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const conditions = [eq(memories.instanceId, instanceId)];
  if (opts.search) conditions.push(ilike(memories.content, `%${escapeLikePattern(opts.search)}%`));
  if (opts.category) conditions.push(eq(memories.category, opts.category));

  const where = and(...conditions);

  const [[totalRow], rows] = await Promise.all([
    db.select({ count: drizzleCount() }).from(memories).where(where),
    db
      .select({
        id: memories.id,
        instanceId: memories.instanceId,
        content: memories.content,
        category: memories.category,
        importance: memories.importance,
        sourceConversationId: memories.sourceConversationId,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(where)
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .offset(offset),
  ]);

  return { memories: rows, total: Number(totalRow.count) };
}

/**
 * Delete a memory by ID only if it belongs to the specified instance.
 * Returns true when a row was deleted, false when not found or owned by another instance.
 */
export async function deleteMemoryForInstance(memoryId: string, instanceId: string): Promise<boolean> {
  const result = await db
    .delete(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.instanceId, instanceId)))
    .returning({ id: memories.id });
  return result.length > 0;
}

/**
 * Delete all memories for a user.
 */
export async function deleteAllMemories(instanceId: string): Promise<void> {
  await db.delete(memories).where(eq(memories.instanceId, instanceId));
}
