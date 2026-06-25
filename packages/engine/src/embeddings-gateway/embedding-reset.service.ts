// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { agents } from "../instances/schema.js";
import { deleteAllMemories } from "../memory/memory-store.js";
import { deleteAllKnowledgeForInstance } from "../knowledge/store.js";
import { defaultDimForProvider } from "./config.js";
import type { EmbeddingDim, EmbeddingProvider } from "./types.js";
import type { AgentSlug, AgentUuid } from "../instances/identifiers.js";

/**
 * Whether the instance's EMBEDDING provider changed (openai↔bedrock). The
 * embedding provider is now an independent field, decoupled from the chat
 * `provider`: changing only the chat LLM never touches embeddings. The embedding
 * space is provider-specific, so a change makes existing vectors uninterpretable
 * by the new provider and forces a wipe.
 */
export function embeddingProviderChanged(
  before: { embeddingProvider: EmbeddingProvider },
  after: { embeddingProvider: EmbeddingProvider },
): boolean {
  return before.embeddingProvider !== after.embeddingProvider;
}

export interface EmbeddingResetResult {
  readonly instanceId: string;
  readonly memoriesDeleted: number;
  readonly knowledgeDocumentsDeleted: number;
  readonly knowledgeChunksDeleted: number;
  readonly newEmbeddingDim: EmbeddingDim;
}

/**
 * Destructive reset run when an instance's embedding provider changes.
 *
 * We deliberately do NOT convert existing vectors: re-embedding is a slow,
 * costly, error-prone migration. Instead the old embedding space is abandoned —
 * every memory and the entire knowledge base (documents + chunks, including raw
 * content) are deleted, then `embedding_dim` is realigned to the new provider's
 * default so future writes target the correct vector column.
 *
 * Conversations are untouched: only extracted memories are removed, so the
 * keyword (FTS) search over raw messages keeps working.
 */
export async function resetEmbeddingsForProviderSwitch(
  slug: AgentSlug,
  uuid: AgentUuid,
  newEmbeddingProvider: EmbeddingProvider,
): Promise<EmbeddingResetResult> {
  const newEmbeddingDim = defaultDimForProvider(newEmbeddingProvider);

  // Single transaction: deleting the data and realigning embedding_dim must be
  // all-or-nothing. A partial apply (data gone, dim still on the old value)
  // would strand the instance in an unembeddable state.
  return db.transaction(async (tx) => {
    // memories + knowledge are SLUG-keyed (their instance_id columns store the
    // slug, not the UUID) — they MUST be filtered by slug or the delete matches
    // zero rows. The instances table is keyed by UUID. Passing the wrong one was
    // the bug that left the data orphaned while only realigning embedding_dim.
    const memoriesDeleted = await deleteAllMemories(slug, undefined, tx);
    const { documents, chunks } = await deleteAllKnowledgeForInstance(slug, tx);

    await tx
      .update(agents)
      .set({ embeddingDim: newEmbeddingDim, updatedAt: new Date() })
      .where(eq(agents.id, uuid));

    return {
      instanceId: uuid,
      memoriesDeleted,
      knowledgeDocumentsDeleted: documents,
      knowledgeChunksDeleted: chunks,
      newEmbeddingDim,
    };
  });
}
