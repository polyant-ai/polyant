// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { deleteAllMemories } from "../memory/memory-store.js";
import { deleteAllKnowledgeForInstance } from "../knowledge/store.js";
import { defaultDimForProvider } from "./config.js";
import type { EmbeddingDim, EmbeddingProvider } from "./types.js";
import type { InstanceSlug, InstanceUuid } from "../instances/identifiers.js";
import { allTenantsScope } from "../authz/scope-filter.js";

/** The two settings that together define an agent's embedding space. */
export interface EmbeddingSpace {
  readonly embeddingProvider: EmbeddingProvider;
  readonly embeddingDim: number;
}

/**
 * Whether the instance's embedding SPACE changed: its embedding provider or its
 * dimension. The embedding provider is an independent field, decoupled from the
 * chat `provider`: changing only the chat LLM never touches embeddings. A vector
 * is only comparable with vectors of the same provider AND the same dimension,
 * so either change makes the existing ones unusable and forces a wipe.
 */
export function embeddingSpaceChanged(before: EmbeddingSpace, after: EmbeddingSpace): boolean {
  return before.embeddingProvider !== after.embeddingProvider || before.embeddingDim !== after.embeddingDim;
}

/**
 * The dimension an agent will embed at after an update. An explicit dimension
 * wins; otherwise a provider switch lands on the new provider's default, and an
 * unchanged provider keeps the stored dimension.
 */
export function nextEmbeddingDim(
  before: EmbeddingSpace,
  nextProvider: EmbeddingProvider,
  requestedDim: EmbeddingDim | undefined,
): number {
  if (requestedDim !== undefined) return requestedDim;
  return nextProvider === before.embeddingProvider ? before.embeddingDim : defaultDimForProvider(nextProvider);
}

export interface EmbeddingResetResult {
  readonly instanceId: string;
  readonly memoriesDeleted: number;
  readonly knowledgeDocumentsDeleted: number;
  readonly knowledgeChunksDeleted: number;
  readonly newEmbeddingDim: EmbeddingDim;
}

/**
 * Destructive reset run when an instance's embedding provider or dimension
 * changes.
 *
 * We deliberately do NOT convert existing vectors: re-embedding is a slow,
 * costly, error-prone migration. Instead the old embedding space is abandoned —
 * every memory and the entire knowledge base (documents + chunks, including raw
 * content) are deleted, then `embedding_dim` is set to the new dimension so
 * future writes target the correct vector column. The caller validates that
 * the provider can emit that dimension (`assertDimSupported`).
 *
 * Conversations are untouched: only extracted memories are removed, so the
 * keyword (FTS) search over raw messages keeps working.
 */
export async function resetEmbeddingSpace(
  slug: InstanceSlug,
  uuid: InstanceUuid,
  newEmbeddingDim: EmbeddingDim,
): Promise<EmbeddingResetResult> {
  // Single transaction: deleting the data and realigning embedding_dim must be
  // all-or-nothing. A partial apply (data gone, dim still on the old value)
  // would strand the instance in an unembeddable state.
  return db.transaction(async (tx) => {
    // memories + knowledge are SLUG-keyed (their instance_id columns store the
    // slug, not the UUID) — they MUST be filtered by slug or the delete matches
    // zero rows. The instances table is keyed by UUID. Passing the wrong one was
    // the bug that left the data orphaned while only realigning embedding_dim.
    // The wipe is scoped by SLUG, which already pins exactly one agent and
    // therefore one tenant; this service runs on an embedding-space change, with no
    // principal to resolve an organization from. It used to pass `undefined`
    // here, which the store read as "no tenant filter" — the same thing a
    // forgotten argument produced, on a DELETE.
    const memoriesDeleted = await deleteAllMemories(
      slug,
      allTenantsScope("embedding space change: scoped by agent slug, runs with no principal"),
      tx,
    );
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
