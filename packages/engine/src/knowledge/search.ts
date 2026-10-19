// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  searchByVector,
  searchByKeyword,
  type KnowledgeSearchResult as StoreResult,
} from "./store.js";
import { embed, resolveEmbeddingContext } from "../embeddings-gateway/index.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { reciprocalRankFusion } from "../utils/rrf.js";
import { createLogger } from "../utils/create-logger.js";

const log = createLogger();

export interface KnowledgeSearchResult {
  content: string;
  score: number;
  source: string; // filename of the parent document
  chunkIndex: number;
}

/**
 * Hybrid search over the knowledge base, combining pgvector cosine similarity
 * with PostgreSQL full-text search. Results are fused with Reciprocal Rank
 * Fusion (RRF, k=60) — same pattern used by the memory layer
 * (see `memory/hybrid-search.ts`).
 *
 * Why both backends:
 * - Pure vector retrieves semantic neighbors but penalises chunks that lack
 *   contextual keywords (e.g. a generic "evening menu" chunk loses to a
 *   "company event on May 26" chunk when the LLM expands the query with
 *   full context).
 * - Pure FTS catches the literal keyword but misses paraphrases.
 *
 * RRF fuses the two rankings without needing to normalise heterogeneous scores.
 *
 * Graceful degradation: if either backend throws, the other still serves
 * results. Only the embedding step (required by vector search) is fatal.
 */
export async function searchKnowledge(
  query: string,
  instanceId: InstanceSlug,
  limit = 5,
): Promise<KnowledgeSearchResult[]> {
  const fetchLimit = Math.max(limit * 2, 20);

  const ctx = await resolveEmbeddingContext(instanceId);
  const queryEmbedding = await embed(query, ctx);

  const [semanticResults, keywordResults] = await Promise.all([
    searchByVector(queryEmbedding, instanceId, fetchLimit, ctx.dimensions).catch((err) => {
      log.error("knowledge", "hybrid search: pgvector backend failed", err);
      return [] as StoreResult[];
    }),
    searchByKeyword(query, instanceId, fetchLimit).catch((err) => {
      log.error("knowledge", "hybrid search: FTS backend failed", err);
      return [] as StoreResult[];
    }),
  ]);

  const toItem = (r: StoreResult): KnowledgeSearchResult => ({
    content: r.content,
    source: r.source,
    chunkIndex: r.chunkIndex,
    score: 0,
  });
  return reciprocalRankFusion(
    [
      { rows: semanticResults, keyOf: (r) => r.id, toItem },
      { rows: keywordResults, keyOf: (r) => r.id, toItem },
    ],
    limit,
  );
}
