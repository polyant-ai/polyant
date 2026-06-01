// SPDX-License-Identifier: AGPL-3.0-or-later

import { chunkText } from "./chunker.js";
import {
  deleteChunksByDocumentId,
  getDocument,
  insertChunksAndFinalize,
  updateDocumentStatus,
} from "./store.js";
import { generateEmbeddings } from "../memory/embedder.js";

/**
 * Process a document: chunk the text, generate embeddings, store chunks.
 * Designed to be called asynchronously after document creation.
 *
 * Chunk insertion + status update are wrapped in a DB transaction:
 * if insertion fails, the document is set to "error" (never "ready" with incomplete data).
 *
 * The document's filename is prepended to the first chunk so the title
 * contributes to both the embedding and the FTS tokens — otherwise a chunk
 * whose body never repeats the document's subject loses retrieval relevance
 * against chunks that mention the surrounding context but not that subject.
 */
export async function processDocument(
  docId: string,
  instanceId: string,
  textContent: string,
  openaiApiKey?: string,
): Promise<{ chunkCount: number }> {
  try {
    await updateDocumentStatus(docId, "processing");

    // Reindex-safe: drop any existing chunks before regenerating.
    // No-op on first ingestion.
    await deleteChunksByDocumentId(docId);

    const chunks = chunkText(textContent);

    if (chunks.length === 0) {
      await updateDocumentStatus(docId, "ready", { chunkCount: 0 });
      return { chunkCount: 0 };
    }

    // Prepend the document title to the first chunk so it contributes to the
    // embedding and FTS tokens (see processDocument docstring).
    const doc = await getDocument(docId);
    const filename = doc?.filename ?? "";
    const titlePrefix = filename ? `# ${filename}\n\n` : "";

    const chunkContents = chunks.map((c, i) =>
      i === 0 && titlePrefix ? `${titlePrefix}${c.content}` : c.content,
    );

    // Generate embeddings in batches
    const BATCH_SIZE = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < chunkContents.length; i += BATCH_SIZE) {
      const batch = chunkContents.slice(i, i + BATCH_SIZE);
      const embeddings = await generateEmbeddings(batch, openaiApiKey);
      allEmbeddings.push(...embeddings);
    }

    // Build chunk records with absolute cumulative chunkIndex (array index, not per-batch)
    const chunkRecords = chunkContents.map((content, i) => ({
      documentId: docId,
      instanceId,
      content,
      embedding: allEmbeddings[i],
      chunkIndex: i,
    }));

    // Insert chunks + mark document as "ready" atomically in a transaction
    const inserted = await insertChunksAndFinalize(docId, chunkRecords);

    console.log(`[Knowledge] Processed doc ${docId}: ${inserted} chunks embedded`);
    return { chunkCount: inserted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Knowledge] Failed to process doc ${docId}: ${message}`);
    await updateDocumentStatus(docId, "error", { errorMessage: message });
    throw err;
  }
}
