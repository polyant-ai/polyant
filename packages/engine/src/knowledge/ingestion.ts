// SPDX-License-Identifier: AGPL-3.0-or-later

import { chunkText } from "./chunker.js";
import {
  getDocument,
  hashContent,
  insertChunksAndFinalize,
  touchDocument,
  updateDocumentStatus,
} from "./store.js";
import { embedMany, resolveEmbeddingContext } from "../embeddings-gateway/index.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { createLogger } from "../utils/create-logger.js";
import { errMsg } from "../utils/error.js";

const log = createLogger();

/**
 * Documents this process indexes at once. A bundle import starts every
 * document's ingestion together, and each pass holds its embeddings in memory
 * (about 30 KB per chunk at 1024 dimensions) and keeps provider calls in
 * flight; the rest wait their turn.
 */
const MAX_CONCURRENT_INGESTIONS = 4;
/** How often a waiting document reports it is still queued, well inside the stuck-document window. */
const QUEUED_KEEPALIVE_MS = 60_000;

let runningIngestions = 0;
const waitingIngestions: Array<() => void> = [];

/** Wait for an ingestion slot; the returned function gives it back. */
async function acquireIngestionSlot(docId: string): Promise<() => void> {
  if (runningIngestions < MAX_CONCURRENT_INGESTIONS) {
    runningIngestions++;
  } else {
    // A queued document is not abandoned: the recovery must not fail it.
    const keepAlive = setInterval(() => {
      touchDocument(docId).catch((err) => log.warn("knowledge", `Could not touch queued doc ${docId}`, err));
    }, QUEUED_KEEPALIVE_MS);
    // The slot passes straight from the pass that ends to this one.
    await new Promise<void>((resolve) => waitingIngestions.push(resolve));
    clearInterval(keepAlive);
  }
  return () => {
    const next = waitingIngestions.shift();
    if (next) next();
    else runningIngestions--;
  };
}

/**
 * Process a document: chunk the text, generate embeddings, store chunks.
 * Designed to be called asynchronously after document creation.
 *
 * Every write is tied to `textContent`: the pass reports on the document and
 * replaces its chunks only while the document still holds that text. A pass
 * whose text was replaced meanwhile (the document was written again) stops
 * without touching it and returns `superseded`; the pass for the new text
 * owns the document. The old chunks stay searchable until the new set
 * replaces them in one transaction; if that fails, the document is set to
 * "error" (never "ready" with incomplete data).
 *
 * The document's filename is prepended to the first chunk so the title
 * contributes to both the embedding and the FTS tokens — otherwise a chunk
 * whose body never repeats the document's subject loses retrieval relevance
 * against chunks that mention the surrounding context but not that subject.
 */
export async function processDocument(
  docId: string,
  instanceId: InstanceSlug,
  textContent: string,
): Promise<{ chunkCount: number; superseded?: true }> {
  const release = await acquireIngestionSlot(docId);
  try {
    return await indexDocument(docId, instanceId, textContent);
  } finally {
    release();
  }
}

async function indexDocument(
  docId: string,
  instanceId: InstanceSlug,
  textContent: string,
): Promise<{ chunkCount: number; superseded?: true }> {
  const textHash = hashContent(textContent);
  const superseded = () => {
    log.info("knowledge", `Skipped doc ${docId}: replaced or deleted while it was being indexed`);
    return { chunkCount: 0, superseded: true as const };
  };
  try {
    if (!(await updateDocumentStatus(docId, "processing", { textHash }))) return superseded();

    const chunks = chunkText(textContent);

    // Prepend the document title to the first chunk so it contributes to the
    // embedding and FTS tokens (see processDocument docstring).
    const doc = chunks.length > 0 ? await getDocument(docId) : undefined;
    const filename = doc?.filename ?? "";
    const titlePrefix = filename ? `# ${filename}\n\n` : "";

    const chunkContents = chunks.map((c, i) =>
      i === 0 && titlePrefix ? `${titlePrefix}${c.content}` : c.content,
    );

    // Resolve the provider-aware embedding context once for the whole document.
    const ctx = await resolveEmbeddingContext(instanceId);

    // Generate embeddings in batches
    const BATCH_SIZE = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < chunkContents.length; i += BATCH_SIZE) {
      const batch = chunkContents.slice(i, i + BATCH_SIZE);
      const embeddings = await embedMany(batch, ctx);
      allEmbeddings.push(...embeddings);
      // Still alive: the stuck-document recovery fails rows nobody touches.
      await touchDocument(docId);
    }

    // Build chunk records with absolute cumulative chunkIndex (array index, not per-batch)
    const chunkRecords = chunkContents.map((content, i) => ({
      documentId: docId,
      instanceId,
      content,
      embedding: allEmbeddings[i],
      chunkIndex: i,
    }));

    // Replace the chunks + mark document as "ready" atomically in a transaction
    const inserted = await insertChunksAndFinalize(
      docId,
      chunkRecords,
      ctx.dimensions,
      ctx.providerName,
      textHash,
    );
    if (inserted === null) return superseded();

    log.info("knowledge", `Processed doc ${docId}: ${inserted} chunks embedded`);
    return { chunkCount: inserted };
  } catch (err) {
    const message = errMsg(err);
    log.error("knowledge", `Failed to process doc ${docId}`, err);
    await updateDocumentStatus(docId, "error", { errorMessage: message, textHash });
    throw err;
  }
}
