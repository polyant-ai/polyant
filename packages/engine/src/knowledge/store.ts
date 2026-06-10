// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "crypto";
import { eq, and, desc, sql, isNotNull, count as drizzleCount } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions";
import { db } from "../database/client.js";
import { knowledgeDocuments, knowledgeChunks } from "./schema.js";
import type { EmbeddingDim, EmbeddingProvider } from "../embeddings-gateway/types.js";
import { vectorColumnValues } from "../embeddings-gateway/dim-columns.js";

// Size caps enforced on agent-originated writes.
export const MAX_WRITE_BYTES = 1 * 1024 * 1024; // 1MB per call
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB per document
const APPEND_SEPARATOR = "\n\n";

export class DocumentSizeExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentSizeExceededError";
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Types ──────────────────────────────────────────────────────────

export interface KnowledgeDocument {
  id: string;
  instanceId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  rawContent: string;
  contentHash: string;
  source: string;
  status: string;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface KnowledgeSearchResult {
  id: string;         // chunk id — used by the hybrid fusion in search.ts to dedup
  content: string;
  score: number;
  source: string;     // filename of the parent document
  chunkIndex: number;
}

// ── Document CRUD ──────────────────────────────────────────────────

export async function createDocument(input: {
  instanceId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  rawContent: string;
  contentHash: string;
  source?: string;
}): Promise<KnowledgeDocument> {
  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      instanceId: input.instanceId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      rawContent: input.rawContent,
      contentHash: input.contentHash,
      source: input.source ?? "upload",
      status: "processing",
    })
    .returning();
  return doc as KnowledgeDocument;
}

export async function updateDocumentStatus(
  docId: string,
  status: "uploading" | "processing" | "ready" | "error",
  extra?: { chunkCount?: number; errorMessage?: string },
): Promise<void> {
  await db
    .update(knowledgeDocuments)
    .set({
      status,
      chunkCount: extra?.chunkCount ?? undefined,
      errorMessage: extra?.errorMessage ?? undefined,
      updatedAt: sql`now()`,
    })
    .where(eq(knowledgeDocuments.id, docId));
}

/** List documents (without rawContent for performance). */
export async function listDocuments(instanceId: string): Promise<Omit<KnowledgeDocument, "rawContent">[]> {
  const rows = await db
    .select({
      id: knowledgeDocuments.id,
      instanceId: knowledgeDocuments.instanceId,
      filename: knowledgeDocuments.filename,
      mimeType: knowledgeDocuments.mimeType,
      sizeBytes: knowledgeDocuments.sizeBytes,
      contentHash: knowledgeDocuments.contentHash,
      source: knowledgeDocuments.source,
      status: knowledgeDocuments.status,
      chunkCount: knowledgeDocuments.chunkCount,
      errorMessage: knowledgeDocuments.errorMessage,
      createdAt: knowledgeDocuments.createdAt,
      updatedAt: knowledgeDocuments.updatedAt,
    })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.instanceId, instanceId))
    .orderBy(desc(knowledgeDocuments.createdAt));
  return rows as Omit<KnowledgeDocument, "rawContent">[];
}

/** Get full document including rawContent. */
export async function getDocument(docId: string): Promise<KnowledgeDocument | undefined> {
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, docId))
    .limit(1);
  return doc as KnowledgeDocument | undefined;
}

/** Delete document + all its chunks (CASCADE via FK, but explicit for safety). */
export async function deleteDocument(docId: string): Promise<boolean> {
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, docId));
  const result = await db
    .delete(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, docId))
    .returning();
  return result.length > 0;
}

/** Get a document by (instanceId, filename). Relies on the UNIQUE constraint. */
export async function getDocumentByFilename(
  instanceId: string,
  filename: string,
): Promise<KnowledgeDocument | undefined> {
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.instanceId, instanceId),
        eq(knowledgeDocuments.filename, filename),
      ),
    )
    .limit(1);
  return doc as KnowledgeDocument | undefined;
}

export interface AgentWriteResult {
  docId: string;
  created: boolean;
  sizeBytes: number;
  rawContent: string;
}

/**
 * Overwrite (or create) a document identified by (instanceId, filename).
 * Marks the document as "processing" so the caller can kick off a reindex.
 */
export async function upsertAgentDocument(input: {
  instanceId: string;
  filename: string;
  content: string;
  mimeType?: string;
}): Promise<AgentWriteResult> {
  const { instanceId, filename, content } = input;
  const mimeType = input.mimeType ?? "text/markdown";
  const sizeBytes = Buffer.byteLength(content, "utf-8");

  if (sizeBytes > MAX_WRITE_BYTES) {
    throw new DocumentSizeExceededError(
      `Input content exceeds ${MAX_WRITE_BYTES} bytes (got ${sizeBytes}).`,
    );
  }
  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    throw new DocumentSizeExceededError(
      `Document exceeds ${MAX_DOCUMENT_BYTES} bytes (got ${sizeBytes}).`,
    );
  }

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.instanceId, instanceId),
          eq(knowledgeDocuments.filename, filename),
        ),
      )
      .for("update")
      .limit(1);

    const hash = hashContent(content);

    if (existing) {
      await tx
        .update(knowledgeDocuments)
        .set({
          mimeType,
          rawContent: content,
          contentHash: hash,
          sizeBytes,
          status: "processing",
          errorMessage: null,
          updatedAt: sql`now()`,
        })
        .where(eq(knowledgeDocuments.id, existing.id));
      return { docId: existing.id, created: false, sizeBytes, rawContent: content };
    }

    const [inserted] = await tx
      .insert(knowledgeDocuments)
      .values({
        instanceId,
        filename,
        mimeType,
        sizeBytes,
        rawContent: content,
        contentHash: hash,
        source: "agent",
        status: "processing",
      })
      .returning({ id: knowledgeDocuments.id });
    return { docId: inserted.id, created: true, sizeBytes, rawContent: content };
  });
}

/**
 * Append content to a document identified by (instanceId, filename).
 * Creates the document (without separator) if it doesn't exist yet.
 * Uses SELECT ... FOR UPDATE to serialize concurrent appends on the same row.
 */
export async function appendAgentDocument(input: {
  instanceId: string;
  filename: string;
  content: string;
  mimeType?: string;
}): Promise<AgentWriteResult> {
  const { instanceId, filename, content } = input;
  const mimeType = input.mimeType ?? "text/markdown";
  const newContentBytes = Buffer.byteLength(content, "utf-8");

  if (newContentBytes > MAX_WRITE_BYTES) {
    throw new DocumentSizeExceededError(
      `Input content exceeds ${MAX_WRITE_BYTES} bytes (got ${newContentBytes}).`,
    );
  }

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: knowledgeDocuments.id,
        rawContent: knowledgeDocuments.rawContent,
      })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.instanceId, instanceId),
          eq(knowledgeDocuments.filename, filename),
        ),
      )
      .for("update")
      .limit(1);

    if (existing) {
      const merged = existing.rawContent
        ? `${existing.rawContent}${APPEND_SEPARATOR}${content}`
        : content;
      const mergedBytes = Buffer.byteLength(merged, "utf-8");
      if (mergedBytes > MAX_DOCUMENT_BYTES) {
        throw new DocumentSizeExceededError(
          `Appending would grow document past ${MAX_DOCUMENT_BYTES} bytes (would be ${mergedBytes}).`,
        );
      }
      await tx
        .update(knowledgeDocuments)
        .set({
          rawContent: merged,
          contentHash: hashContent(merged),
          sizeBytes: mergedBytes,
          status: "processing",
          errorMessage: null,
          updatedAt: sql`now()`,
        })
        .where(eq(knowledgeDocuments.id, existing.id));
      return {
        docId: existing.id,
        created: false,
        sizeBytes: mergedBytes,
        rawContent: merged,
      };
    }

    // Doc doesn't exist → create fresh (no separator prefix)
    const [inserted] = await tx
      .insert(knowledgeDocuments)
      .values({
        instanceId,
        filename,
        mimeType,
        sizeBytes: newContentBytes,
        rawContent: content,
        contentHash: hashContent(content),
        source: "agent",
        status: "processing",
      })
      .returning({ id: knowledgeDocuments.id });
    return {
      docId: inserted.id,
      created: true,
      sizeBytes: newContentBytes,
      rawContent: content,
    };
  });
}

/** Delete all chunks belonging to a document (used before reindexing). */
export async function deleteChunksByDocumentId(docId: string): Promise<number> {
  const deleted = await db
    .delete(knowledgeChunks)
    .where(eq(knowledgeChunks.documentId, docId))
    .returning({ id: knowledgeChunks.id });
  return deleted.length;
}

/**
 * Reset documents stuck in "processing" for longer than `minutes`.
 * Used at boot to recover from crashed reindex jobs.
 */
export async function resetStuckProcessingAll(minutes = 5): Promise<number> {
  const cutoff = sql`now() - make_interval(mins => ${minutes})`;
  const reset = await db
    .update(knowledgeDocuments)
    .set({
      status: "error",
      errorMessage: `Reindex interrupted (boot cleanup after ${minutes} minutes)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(knowledgeDocuments.status, "processing"),
        sql`${knowledgeDocuments.updatedAt} < ${cutoff}`,
      ),
    )
    .returning({ id: knowledgeDocuments.id });
  return reset.length;
}

// ── Chunk operations ───────────────────────────────────────────────

/** Pick the active Drizzle column based on embedding dim. */
function activeKnowledgeChunkColumn(dim: EmbeddingDim) {
  return dim === 1024 ? knowledgeChunks.embedding1024 : knowledgeChunks.embedding;
}

export interface InsertChunkInput {
  documentId: string;
  instanceId: string;
  content: string;
  embedding: number[];
  chunkIndex: number;
}

/** Build row values for a chunk insert — populates the active column, NULLs the other. */
function chunkRowValues(c: InsertChunkInput, dimensions: EmbeddingDim, provider: EmbeddingProvider) {
  return {
    documentId: c.documentId,
    instanceId: c.instanceId,
    content: c.content,
    ...vectorColumnValues(dimensions, c.embedding),
    embeddingProvider: provider,
    chunkIndex: c.chunkIndex,
  };
}

export async function insertChunks(
  chunks: InsertChunkInput[],
  dimensions: EmbeddingDim,
  provider: EmbeddingProvider,
): Promise<number> {
  if (chunks.length === 0) return 0;

  await db.insert(knowledgeChunks).values(
    chunks.map((c) => chunkRowValues(c, dimensions, provider)),
  );
  return chunks.length;
}

/**
 * Insert chunks and update document status atomically in a transaction.
 * If chunk insertion fails, the document status is NOT updated to "ready".
 */
export async function insertChunksAndFinalize(
  docId: string,
  chunks: InsertChunkInput[],
  dimensions: EmbeddingDim,
  provider: EmbeddingProvider,
): Promise<number> {
  if (chunks.length === 0) {
    await updateDocumentStatus(docId, "ready", { chunkCount: 0 });
    return 0;
  }

  return await db.transaction(async (tx) => {
    await tx.insert(knowledgeChunks).values(
      chunks.map((c) => chunkRowValues(c, dimensions, provider)),
    );

    await tx
      .update(knowledgeDocuments)
      .set({
        status: "ready",
        chunkCount: chunks.length,
        updatedAt: sql`now()`,
      })
      .where(eq(knowledgeDocuments.id, docId));

    return chunks.length;
  });
}

// ── Search ─────────────────────────────────────────────────────────

/**
 * Semantic search: find nearest chunks and return with parent document filename.
 * Used as one of the two backends fused by `searchKnowledge()` in search.ts.
 */
export async function searchByVector(
  queryEmbedding: number[],
  instanceId: string,
  limit = 5,
  dimensions: EmbeddingDim,
): Promise<KnowledgeSearchResult[]> {
  const activeCol = activeKnowledgeChunkColumn(dimensions);
  const distance = cosineDistance(activeCol, queryEmbedding);

  const rows = await db
    .select({
      id: knowledgeChunks.id,
      content: knowledgeChunks.content,
      chunkIndex: knowledgeChunks.chunkIndex,
      filename: knowledgeDocuments.filename,
      distance: sql<number>`${distance}`,
    })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
    // Exclude rows whose active vector column is NULL: their cosine distance is
    // NULL → `1 - NULL` = NaN, which would otherwise leak a NaN score into the
    // knowledge search results when fewer than `limit` rows match.
    .where(and(eq(knowledgeChunks.instanceId, instanceId), isNotNull(activeCol)))
    .orderBy(distance)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    score: Math.round((1 - r.distance) * 10000) / 10000,
    source: r.filename,
    chunkIndex: r.chunkIndex,
  }));
}

/**
 * Keyword search: PostgreSQL FTS over the chunk content, ranked by ts_rank.
 * Uses `simple` config (no language stemming) for multilingual coherence with
 * the rest of the project (see CLAUDE.md). `websearch_to_tsquery` accepts the
 * raw user query — no manual escaping needed.
 */
export async function searchByKeyword(
  query: string,
  instanceId: string,
  limit = 5,
): Promise<KnowledgeSearchResult[]> {
  const rows = await db.execute(sql`
    SELECT
      kc.id,
      kc.content,
      kc.chunk_index,
      kd.filename,
      ts_rank(kc.content_tsv, websearch_to_tsquery('simple', ${query})) AS rank
    FROM knowledge_chunks kc
    INNER JOIN knowledge_documents kd ON kd.id = kc.document_id
    WHERE kc.instance_id = ${instanceId}
      AND kc.content_tsv @@ websearch_to_tsquery('simple', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    content: r.content as string,
    score: Math.round(((r.rank as number) ?? 0) * 10000) / 10000,
    source: r.filename as string,
    chunkIndex: (r.chunk_index as number) ?? 0,
  }));
}

export async function countChunks(instanceId: string): Promise<number> {
  const [row] = await db
    .select({ count: drizzleCount() })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.instanceId, instanceId));
  return Number(row.count);
}

/** Count knowledge documents owned by an instance (used to enforce the per-instance cap). */
export async function countDocuments(instanceId: string): Promise<number> {
  const [row] = await db
    .select({ count: drizzleCount() })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.instanceId, instanceId));
  return Number(row.count);
}
