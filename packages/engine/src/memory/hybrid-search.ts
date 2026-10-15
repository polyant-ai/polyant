// SPDX-License-Identifier: AGPL-3.0-or-later

import { searchByVector } from "./memory-store.js";
import { embed, resolveEmbeddingContext } from "../embeddings-gateway/index.js";
import { conversationStore } from "../conversations/index.js";
import { memoryLog } from "./memory-logger.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import { allTenantsScope } from "../authz/scope-filter.js";
import { reciprocalRankFusion } from "../utils/rrf.js";

export interface HybridSearchResult {
  content: string;
  type: "memory" | "conversation";
  score: number;
  source: string;
  createdAt: string;
}

/**
 * Hybrid search combining pgvector semantic search with PostgreSQL FTS keyword search.
 * Results are fused using Reciprocal Rank Fusion (RRF).
 *
 * - Semantic backend: pgvector cosine similarity over extracted memories
 * - Keyword backend: PostgreSQL full-text search over raw conversation messages
 * - Fusion: RRF with k=60
 */
export async function hybridSearch(
  query: string,
  instanceId: InstanceSlug,
  limit = 10,
): Promise<HybridSearchResult[]> {
  const uid = instanceId;
  const fetchLimit = Math.max(limit * 2, 20);

  // The keyword half needs neither the embedding context nor the embedding, so
  // it starts now and overlaps the embedding round trip. Its own catch keeps a
  // failure here from surfacing if the embedding step throws first.
  const keywordSearch = conversationStore.searchByKeyword(
    allTenantsScope("hybrid search runs in a turn, with no principal; the agent slug already pins one tenant"),
    query,
    uid,
    fetchLimit,
  ).catch((err) => {
    memoryLog.error("HybridSearch", "PostgreSQL keyword search failed:", err);
    return [];
  });

  // Generate embedding for the query via the provider-aware gateway
  const ctx = await resolveEmbeddingContext(uid);
  const queryEmbedding = await embed(query, ctx);

  const [semanticResults, keywordResults] = await Promise.all([
    searchByVector(queryEmbedding, uid, fetchLimit, ctx.dimensions).catch((err) => {
      memoryLog.error("HybridSearch", "pgvector semantic search failed:", err);
      return [];
    }),
    keywordSearch,
  ]);

  return reciprocalRankFusion<HybridSearchResult>(
    [
      {
        rows: semanticResults,
        keyOf: (r) => `mem:${r.id}`,
        toItem: (r) => ({
          content: r.content,
          type: "memory",
          score: 0,
          source: r.id,
          createdAt: r.createdAt?.toISOString() ?? "",
        }),
      },
      {
        // The same document found in both backends sums its scores.
        rows: keywordResults,
        keyOf: (r) => `pg:${r.id}`,
        toItem: (r) => ({
          content: r.content,
          type: "conversation",
          score: 0,
          source: r.id,
          createdAt: r.createdAt?.toISOString() ?? "",
        }),
      },
    ],
    limit,
  );
}
