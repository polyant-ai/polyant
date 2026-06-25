// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, desc, sql, gt, and, ilike, isNotNull, count as drizzleCount } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions";
import { db, type DbExecutor } from "../database/client.js";
import { memories } from "./schema.js";
import { config } from "../config.js";
import { asAgentSlug, type AgentSlug } from "../instances/identifiers.js";
import type { EmbeddingDim, EmbeddingProvider } from "../embeddings-gateway/types.js";
import { vectorColumnValues } from "../embeddings-gateway/dim-columns.js";
import { buildOrgScopedAgentFilter } from "../authz/scope-filter.js";

// ---- Types ----

export interface MemoryRecord {
  id: string;
  agentId: AgentSlug;
  content: string;
  category: string;
  importance: number;
  sourceConversationId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface InsertMemoryInput {
  agentId: AgentSlug;
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
const MAX_UPSERT_RETRIES = 5;
/** Base backoff in ms — actual delay is `BASE * 2^attempt + random(0, BASE * 2^attempt)`. */
const RETRY_BASE_BACKOFF_MS = 20;

function isSerializationFailure(err: unknown): boolean {
  // postgres-js wraps the original error in DrizzleQueryError; the SQLSTATE
  // lives on `err.cause.code`. Older paths still carry it on `err.code`.
  if (!(err instanceof Error)) return false;
  if ("code" in err && (err as Error & { code: string }).code === SERIALIZATION_FAILURE) {
    return true;
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && "code" in cause && (cause as Error & { code: string }).code === SERIALIZATION_FAILURE) {
    return true;
  }
  return false;
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
        eq(memories.agentId, input.agentId),
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
        agentId: input.agentId,
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
 * Retries on `serialization_failure` (40001) with exponential backoff + jitter.
 * The jitter desynchronises retries so two transactions that collided at attempt
 * N don't all re-fire at the same time and re-collide at attempt N+1.
 * Cumulative max wait across 5 attempts: ~640 ms (still fire-and-forget friendly).
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
        const base = RETRY_BASE_BACKOFF_MS * Math.pow(2, attempt);
        const jitter = Math.random() * base;
        await new Promise((resolve) => setTimeout(resolve, base + jitter));
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
  agentId: AgentSlug,
  limit = 10,
  dimensions: EmbeddingDim,
): Promise<Array<MemoryRecord & { similarity: number }>> {
  const activeCol = activeEmbeddingColumn(dimensions);
  const distance = cosineDistance(activeCol, queryEmbedding);

  const rows = await db
    .select({
      id: memories.id,
      agentId: memories.agentId,
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
    .where(and(eq(memories.agentId, agentId), isNotNull(activeCol)))
    .orderBy(distance)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    agentId: asAgentSlug(r.agentId),
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
export async function getAllMemories(agentId: AgentSlug): Promise<MemoryRecord[]> {
  const rows = await db
    .select({
      id: memories.id,
      agentId: memories.agentId,
      content: memories.content,
      category: memories.category,
      importance: memories.importance,
      sourceConversationId: memories.sourceConversationId,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(eq(memories.agentId, agentId))
    .orderBy(desc(memories.updatedAt));

  return rows.map((r) => ({ ...r, agentId: asAgentSlug(r.agentId) }));
}

/**
 * Search memories with pagination, text filtering (ILIKE), and category filtering.
 */
export async function searchMemories(
  agentId: AgentSlug,
  opts: { search?: string; category?: string; limit?: number; offset?: number; orgId?: string } = {},
): Promise<{ memories: MemoryRecord[]; total: number }> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const conditions = [eq(memories.agentId, agentId)];
  if (opts.search) conditions.push(ilike(memories.content, `%${escapeLikePattern(opts.search)}%`));
  if (opts.category) conditions.push(eq(memories.category, opts.category));
  // Cross-org gate: even with a valid-looking agentId, only return rows whose
  // agent belongs to the caller's org (closes param-IDOR at the store layer).
  if (opts.orgId) conditions.push(buildOrgScopedAgentFilter(opts.orgId));

  const where = and(...conditions);

  const [[totalRow], rows] = await Promise.all([
    db.select({ count: drizzleCount() }).from(memories).where(where),
    db
      .select({
        id: memories.id,
        agentId: memories.agentId,
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

  return {
    memories: rows.map((r) => ({ ...r, agentId: asAgentSlug(r.agentId) })),
    total: Number(totalRow.count),
  };
}

/**
 * Delete a memory by ID only if it belongs to the specified instance.
 * Returns true when a row was deleted, false when not found or owned by another instance.
 */
export async function deleteMemoryForInstance(
  memoryId: string,
  agentId: AgentSlug,
  orgId?: string,
): Promise<boolean> {
  const conditions = [eq(memories.id, memoryId), eq(memories.agentId, agentId)];
  // Cross-org gate: a foreign-org agentId never matches the org subquery, so
  // an Org-A caller cannot delete an Org-B memory by id.
  if (orgId) conditions.push(buildOrgScopedAgentFilter(orgId));
  const result = await db
    .delete(memories)
    .where(and(...conditions))
    .returning({ id: memories.id });
  return result.length > 0;
}

/**
 * Delete all memories for a user. Returns the number of rows removed. Accepts an
 * optional executor (transaction) so the destructive embedding reset can wipe
 * memories + knowledge + realign embedding_dim atomically, and an optional
 * `orgId` cross-org gate so an Org-A caller cannot wipe an Org-B agent's memories
 * via a foreign-org instanceId (param-IDOR closed at the store layer).
 */
export async function deleteAllMemories(
  agentId: AgentSlug,
  orgId?: string,
  executor: DbExecutor = db,
): Promise<number> {
  const conditions = [eq(memories.agentId, agentId)];
  if (orgId) conditions.push(buildOrgScopedAgentFilter(orgId));
  const deleted = await executor
    .delete(memories)
    .where(and(...conditions))
    .returning({ id: memories.id });
  return deleted.length;
}

/** Count memories owned by an agent. */
export async function countMemories(agentId: AgentSlug): Promise<number> {
  const [row] = await db
    .select({ count: drizzleCount() })
    .from(memories)
    .where(eq(memories.agentId, agentId));
  return Number(row.count);
}
