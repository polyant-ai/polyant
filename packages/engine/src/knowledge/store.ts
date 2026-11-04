// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "crypto";
import { extname } from "path";
import { eq, and, desc, sql, inArray, isNotNull, count as drizzleCount } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions";
import { db, type DbExecutor, type DbTransaction } from "../database/client.js";
import { completeVectorScanSetting } from "../database/vector-scan.js";
import { knowledgeDocuments, knowledgeChunks } from "./schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";
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
  instanceId: InstanceSlug;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  rawContent: string;
  contentHash: string;
  source: string;
  status: string;
  chunkCount: number;
  errorMessage: string | null;
  /** Off: stored, but retrieval skips it. */
  enabled: boolean;
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
  instanceId: InstanceSlug;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  rawContent: string;
  contentHash: string;
  source?: string;
  enabled?: boolean;
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
      enabled: input.enabled ?? true,
      status: "processing",
    })
    .returning();
  return doc as KnowledgeDocument;
}

/**
 * The document's stored text still hashes to `textHash`. Computed from
 * `raw_content` itself, so it holds for rows whose `content_hash` predates the
 * column or was written by another path.
 */
function storedTextIs(textHash: string) {
  return sql`encode(sha256(convert_to(${knowledgeDocuments.rawContent}, 'UTF8')), 'hex') = ${textHash}`;
}

/**
 * Set a document's status. With `textHash`, only while the document still holds
 * the text with that hash: an indexing pass for text that has since been
 * replaced must not report on the document. Returns whether a row changed.
 */
export async function updateDocumentStatus(
  docId: string,
  status: "uploading" | "processing" | "ready" | "error",
  extra?: { chunkCount?: number; errorMessage?: string; textHash?: string },
): Promise<boolean> {
  const rows = await db
    .update(knowledgeDocuments)
    .set({
      status,
      chunkCount: extra?.chunkCount ?? undefined,
      errorMessage: extra?.errorMessage ?? undefined,
      updatedAt: sql`now()`,
    })
    .where(and(eq(knowledgeDocuments.id, docId), extra?.textHash ? storedTextIs(extra.textHash) : undefined))
    .returning({ id: knowledgeDocuments.id });
  return rows.length > 0;
}

/**
 * One page of an agent's documents, newest first, without rawContent.
 * `nextOffset` is where the next page starts, or null after the last one.
 */
export async function listDocuments(
  instanceId: InstanceSlug,
  page: { limit: number; offset: number },
): Promise<{ documents: Omit<KnowledgeDocument, "rawContent">[]; nextOffset: number | null }> {
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
      enabled: knowledgeDocuments.enabled,
      createdAt: knowledgeDocuments.createdAt,
      updatedAt: knowledgeDocuments.updatedAt,
    })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.instanceId, instanceId))
    .orderBy(desc(knowledgeDocuments.createdAt), desc(knowledgeDocuments.id))
    // One row past the page says whether another page follows.
    .limit(page.limit + 1)
    .offset(page.offset);
  const more = rows.length > page.limit;
  return {
    documents: (more ? rows.slice(0, page.limit) : rows) as Omit<KnowledgeDocument, "rawContent">[],
    nextOffset: more ? page.offset + page.limit : null,
  };
}

/**
 * Turn a document on or off for retrieval. Scoped to the agent: a document of
 * another agent is not found. Returns whether a row changed.
 */
export async function setDocumentEnabled(docId: string, instanceId: InstanceSlug, enabled: boolean): Promise<boolean> {
  const rows = await db
    .update(knowledgeDocuments)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(knowledgeDocuments.id, docId), eq(knowledgeDocuments.instanceId, instanceId)))
    .returning({ id: knowledgeDocuments.id });
  return rows.length > 0;
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

/**
 * Delete the entire knowledge base for an instance — every document (including
 * its raw content) and every chunk. Used by the destructive embedding reset on
 * a provider switch, where existing vectors are abandoned rather than converted.
 * Returns the counts removed.
 *
 * Accepts an optional transaction so the caller can wipe memories + knowledge +
 * realign embedding_dim atomically. Standalone, it opens its own transaction so
 * the chunk/document deletes never partially apply.
 */
export async function deleteAllKnowledgeForInstance(
  instanceId: InstanceSlug,
  tx?: DbTransaction,
): Promise<{ documents: number; chunks: number }> {
  const run = async (ex: DbExecutor) => {
    const chunks = await ex
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.instanceId, instanceId))
      .returning({ id: knowledgeChunks.id });
    const docs = await ex
      .delete(knowledgeDocuments)
      .where(eq(knowledgeDocuments.instanceId, instanceId))
      .returning({ id: knowledgeDocuments.id });
    return { documents: docs.length, chunks: chunks.length };
  };
  return tx ? run(tx) : db.transaction(run);
}

/** A single document in an export bundle — filename + raw content + metadata. */
export interface ExportedDocument {
  filename: string;
  content: string;
  mimeType: string;
  source: string;
  contentHash: string;
  enabled: boolean;
}

/**
 * Return every document for an instance with its raw content, for export.
 * Ordered oldest-first so a re-import preserves the original upload order.
 */
export async function getKnowledgeForExport(instanceId: InstanceSlug): Promise<ExportedDocument[]> {
  const rows = await db
    .select({
      filename: knowledgeDocuments.filename,
      content: knowledgeDocuments.rawContent,
      mimeType: knowledgeDocuments.mimeType,
      source: knowledgeDocuments.source,
      contentHash: knowledgeDocuments.contentHash,
      enabled: knowledgeDocuments.enabled,
    })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.instanceId, instanceId))
    .orderBy(knowledgeDocuments.createdAt);
  return rows;
}

/** All existing filenames for an instance — used to resolve import collisions. */
export async function listDocumentFilenames(instanceId: InstanceSlug): Promise<string[]> {
  const rows = await db
    .select({ filename: knowledgeDocuments.filename })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.instanceId, instanceId));
  return rows.map((r) => r.filename);
}

/**
 * Resolve a collision-free filename by appending " (n)" before the extension
 * (e.g. "manuale.txt" → "manuale (1).txt" → "manuale (2).txt"). Pure — `taken`
 * is the set of names already in use (existing + earlier in the same batch).
 */
export function resolveUniqueFilename(filename: string, taken: Set<string>): string {
  if (!taken.has(filename)) return filename;
  const ext = extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let n = 1;
  let candidate = `${base} (${n})${ext}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

/** Get a document by (instanceId, filename). Relies on the UNIQUE constraint. */
export async function getDocumentByFilename(
  instanceId: InstanceSlug,
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
  /** False when the text is unchanged on a document already indexed: its chunks stand. */
  reindex: boolean;
}

type AgentWriteInput = {
  instanceId: InstanceSlug;
  filename: string;
  content: string;
  mimeType?: string;
};

/**
 * One transaction for both agent writes: size-check the input, lock the row by
 * (instanceId, filename), then update it or insert it as "processing" so the
 * caller can kick off a reindex. `mode` only decides how the stored content is
 * derived: "overwrite" replaces it (and its mime type); "append" joins the
 * existing text and the input with a separator, and creates the document
 * without one when absent. SELECT ... FOR UPDATE serializes concurrent writes
 * on the same row.
 *
 * A write that leaves the text of a ready document as it is (a plugin syncing
 * the same catalogue, a repeated write) keeps the document ready and asks for
 * no reindex: re-embedding identical text costs provider time for no change.
 */
async function writeAgentDocument(
  input: AgentWriteInput,
  mode: "overwrite" | "append",
): Promise<AgentWriteResult> {
  const { instanceId, filename, content } = input;
  const mimeType = input.mimeType ?? "text/markdown";
  const inputBytes = Buffer.byteLength(content, "utf-8");

  if (inputBytes > MAX_WRITE_BYTES) {
    throw new DocumentSizeExceededError(
      `Input content exceeds ${MAX_WRITE_BYTES} bytes (got ${inputBytes}).`,
    );
  }

  return await db.transaction(async (tx) => {
    // Only an append needs the stored text; an overwrite must not drag a
    // document of up to 10MB over the wire just to replace it.
    const [existing] = await tx
      .select({
        id: knowledgeDocuments.id,
        rawContent: mode === "append" ? knowledgeDocuments.rawContent : sql<null>`null`,
        contentHash: knowledgeDocuments.contentHash,
        status: knowledgeDocuments.status,
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
      const merged =
        mode === "append" && existing.rawContent
          ? `${existing.rawContent}${APPEND_SEPARATOR}${content}`
          : content;
      const mergedBytes = mode === "append" ? Buffer.byteLength(merged, "utf-8") : inputBytes;
      if (mode === "append" && mergedBytes > MAX_DOCUMENT_BYTES) {
        throw new DocumentSizeExceededError(
          `Appending would grow document past ${MAX_DOCUMENT_BYTES} bytes (would be ${mergedBytes}).`,
        );
      }
      const mergedHash = hashContent(merged);
      const reindex = !(existing.status === "ready" && existing.contentHash === mergedHash);
      if (reindex) {
        await tx
          .update(knowledgeDocuments)
          .set({
            ...(mode === "overwrite" ? { mimeType } : {}),
            rawContent: merged,
            contentHash: mergedHash,
            sizeBytes: mergedBytes,
            status: "processing",
            errorMessage: null,
            updatedAt: sql`now()`,
          })
          .where(eq(knowledgeDocuments.id, existing.id));
      } else if (mode === "overwrite") {
        await tx.update(knowledgeDocuments).set({ mimeType }).where(eq(knowledgeDocuments.id, existing.id));
      }
      return { docId: existing.id, created: false, sizeBytes: mergedBytes, rawContent: merged, reindex };
    }

    const [inserted] = await tx
      .insert(knowledgeDocuments)
      .values({
        instanceId,
        filename,
        mimeType,
        sizeBytes: inputBytes,
        rawContent: content,
        contentHash: hashContent(content),
        source: "agent",
        status: "processing",
      })
      .returning({ id: knowledgeDocuments.id });
    return { docId: inserted.id, created: true, sizeBytes: inputBytes, rawContent: content, reindex: true };
  });
}

/**
 * Overwrite (or create) a document identified by (instanceId, filename).
 * Marks the document as "processing" so the caller can kick off a reindex.
 */
export function upsertAgentDocument(input: AgentWriteInput): Promise<AgentWriteResult> {
  return writeAgentDocument(input, "overwrite");
}

/**
 * Append content to a document identified by (instanceId, filename).
 * Creates the document (without separator) if it doesn't exist yet.
 */
export function appendAgentDocument(input: AgentWriteInput): Promise<AgentWriteResult> {
  return writeAgentDocument(input, "append");
}

/**
 * Report that a document's ingestion is still making progress.
 *
 * Ingestion runs in the process that accepted the upload, so a document is
 * only "in flight" while that process keeps touching it. The recovery below
 * reads a row nobody touched for minutes as abandoned, which is what lets it
 * run while other replicas are ingesting.
 */
export async function touchDocument(docId: string): Promise<void> {
  await db
    .update(knowledgeDocuments)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(knowledgeDocuments.id, docId), inArray(knowledgeDocuments.status, ["uploading", "processing"])));
}

/**
 * Fail documents left "uploading" or "processing" with no progress for
 * `minutes`: the process that was ingesting them is gone. Left alone they read
 * as "still working" for ever, and nobody re-uploads a document that looks busy.
 * Runs at boot and then periodically, so a restart within the window does not
 * hide a document from every later check.
 */
export async function resetStuckProcessingAll(minutes = 5): Promise<number> {
  const cutoff = sql`now() - make_interval(mins => ${minutes})`;
  const reset = await db
    .update(knowledgeDocuments)
    .set({
      status: "error",
      errorMessage: `Ingestion interrupted (no progress for ${minutes} minutes)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        inArray(knowledgeDocuments.status, ["uploading", "processing"]),
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

/** Chunks per INSERT statement when a document's chunks are stored. */
const INSERT_BLOCK_SIZE = 500;

/**
 * Replace a document's chunks and mark it ready, in one transaction, if the
 * document still holds the text the chunks were made from (`textHash`).
 *
 * Two passes can index one document at once (two agent writes in a row, an
 * upload while the agent writes). The row lock taken here, and by the agent
 * writes, orders them: a pass for replaced text writes nothing, and a pass for
 * the current text swaps the whole set, so the chunks are never doubled or
 * mixed. Until the swap the previous chunks stay searchable. Returns the chunk
 * count, or null when the text was replaced and nothing was written. If the
 * insert fails, nothing changes and the document is NOT marked "ready".
 */
export async function insertChunksAndFinalize(
  docId: string,
  chunks: InsertChunkInput[],
  dimensions: EmbeddingDim,
  provider: EmbeddingProvider,
  textHash: string,
): Promise<number | null> {
  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, docId), storedTextIs(textHash)))
      .for("update");
    if (!current) return null;

    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, docId));
    // In blocks: one statement for a whole large document holds every vector,
    // as text, in memory at once.
    for (let i = 0; i < chunks.length; i += INSERT_BLOCK_SIZE) {
      await tx.insert(knowledgeChunks).values(
        chunks.slice(i, i + INSERT_BLOCK_SIZE).map((c) => chunkRowValues(c, dimensions, provider)),
      );
    }

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
 *
 * The 1024-dim column has one HNSW index for the whole table, and the planner
 * picks it once an agent holds thousands of chunks. The index returns its
 * `hnsw.ef_search` (40) nearest rows of every agent and the agent filter runs
 * after it, so an agent owning a fraction of those rows got that fraction of
 * `limit`. The query therefore runs in a transaction that keeps it complete:
 * with `iterative_scan = strict_order` the index keeps scanning, in distance
 * order, until `limit` rows pass the filter (or `hnsw.max_scan_tuples`, 20,000
 * by default, have been visited); on a pgvector without it the index is off
 * for the query and the agent's chunks are scanned exactly.
 */
export async function searchByVector(
  queryEmbedding: number[],
  instanceId: InstanceSlug,
  limit = 5,
  dimensions: EmbeddingDim,
): Promise<KnowledgeSearchResult[]> {
  const activeCol = activeKnowledgeChunkColumn(dimensions);
  const distance = cosineDistance(activeCol, queryEmbedding);
  const completeScan = await completeVectorScanSetting();

  const rows = await db.transaction(async (tx) => {
    await tx.execute(completeScan);
    return await tx
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
      .where(and(eq(knowledgeChunks.instanceId, instanceId), eq(knowledgeDocuments.enabled, true), isNotNull(activeCol)))
      .orderBy(distance)
      .limit(limit);
  });

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    score: Math.round((1 - r.distance) * 10000) / 10000,
    source: r.filename,
    chunkIndex: r.chunkIndex,
  }));
}

/**
 * Keyword search: PostgreSQL FTS over the chunk content, ranked by cover density.
 *
 * A chunk matches when it holds ANY word of the question; chunks holding more
 * of them, closer together, rank higher. The words come from the
 * `knowledge_query` configuration, which reads them like the chunks' `simple`
 * index (no stemming, for multilingual coherence) and drops Italian and English
 * stopwords. Requiring every word, stopwords included, made a question in
 * natural language ("what are the opening hours?") match nothing. A question
 * with no word left matches nothing.
 *
 * The tsquery is assembled from the lexemes, each quoted (quotes and
 * backslashes doubled) and joined with OR, so the raw question needs no
 * escaping and an empty question yields NULL instead of a server notice.
 */
export async function searchByKeyword(
  query: string,
  instanceId: InstanceSlug,
  limit = 5,
): Promise<KnowledgeSearchResult[]> {
  const anyWord = sql`(
    SELECT string_agg($q$'$q$ || replace(replace(lexeme, $q$\\$q$, $q$\\\\$q$), $q$'$q$, $q$''$q$) || $q$'$q$, ' | ')::tsquery
    FROM unnest(to_tsvector('knowledge_query', ${query}))
  )`;
  const rows = await db.execute(sql`
    SELECT
      kc.id,
      kc.content,
      kc.chunk_index,
      kd.filename,
      ts_rank_cd(kc.content_tsv, ${anyWord}) AS rank
    FROM knowledge_chunks kc
    INNER JOIN knowledge_documents kd ON kd.id = kc.document_id
    WHERE kc.instance_id = ${instanceId}
      AND kd.enabled
      AND kc.content_tsv @@ ${anyWord}
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

export async function countChunks(instanceId: InstanceSlug): Promise<number> {
  const [row] = await db
    .select({ count: drizzleCount() })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.instanceId, instanceId));
  return Number(row.count);
}

/** Count knowledge documents owned by an instance (used to enforce the per-instance cap). */
export async function countDocuments(instanceId: InstanceSlug): Promise<number> {
  const [row] = await db
    .select({ count: drizzleCount() })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.instanceId, instanceId));
  return Number(row.count);
}
