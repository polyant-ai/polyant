// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { deleteAllMemories } from "../memory/memory-store.js";
import { deleteAllKnowledgeForInstance } from "../knowledge/store.js";
import { embeddingProviderFor, defaultDimForProvider } from "./config.js";
import type { EmbeddingDim } from "./types.js";
import type { InstanceSlug, InstanceUuid } from "../instances/identifiers.js";

/**
 * Whether switching an instance's chat provider also changes its EMBEDDING
 * provider (openai↔bedrock). Anthropic↔OpenAI keeps the same embedding provider
 * (openai) and therefore needs no reset. The embedding space is provider-specific:
 * a change makes existing vectors uninterpretable by the new provider.
 */
export function embeddingProviderChanged(
  before: { provider?: string | null },
  after: { provider?: string | null },
): boolean {
  return embeddingProviderFor(before.provider) !== embeddingProviderFor(after.provider);
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
  slug: InstanceSlug,
  uuid: InstanceUuid,
  newProvider: string | null | undefined,
): Promise<EmbeddingResetResult> {
  const embeddingProvider = embeddingProviderFor(newProvider);
  const newEmbeddingDim = defaultDimForProvider(embeddingProvider);

  // Single transaction: deleting the data and realigning embedding_dim must be
  // all-or-nothing. A partial apply (data gone, dim still on the old value)
  // would strand the instance in an unembeddable state.
  return db.transaction(async (tx) => {
    // memories + knowledge are SLUG-keyed (their instance_id columns store the
    // slug, not the UUID) — they MUST be filtered by slug or the delete matches
    // zero rows. The instances table is keyed by UUID. Passing the wrong one was
    // the bug that left the data orphaned while only realigning embedding_dim.
    const memoriesDeleted = await deleteAllMemories(slug, tx);
    const { documents, chunks } = await deleteAllKnowledgeForInstance(slug, tx);

    await tx
      .update(instances)
      .set({ embeddingDim: newEmbeddingDim, updatedAt: new Date() })
      .where(eq(instances.id, uuid));

    return {
      instanceId: uuid,
      memoriesDeleted,
      knowledgeDocumentsDeleted: documents,
      knowledgeChunksDeleted: chunks,
      newEmbeddingDim,
    };
  });
}
