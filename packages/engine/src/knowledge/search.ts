// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  searchByVector,
  searchByKeyword,
  type KnowledgeSearchResult as StoreResult,
} from "./store.js";
import { embed, resolveEmbeddingContext } from "../embeddings-gateway/index.js";

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
 *   contextual keywords (e.g. a "Menu della serata" chunk loses to an "evento
 *   Exelab 26 maggio" chunk when the LLM expands the query with full context).
 * - Pure FTS catches the literal keyword but misses paraphrases.
 *
 * RRF fuses the two rankings without needing to normalise heterogeneous scores.
 *
 * Graceful degradation: if either backend throws, the other still serves
 * results. Only the embedding step (required by vector search) is fatal.
 */
export async function searchKnowledge(
  query: string,
  instanceId: string,
  limit = 5,
): Promise<KnowledgeSearchResult[]> {
  const fetchLimit = Math.max(limit * 2, 20);

  const ctx = await resolveEmbeddingContext(instanceId);
  const queryEmbedding = await embed(query, ctx);

  const [semanticResults, keywordResults] = await Promise.all([
    searchByVector(queryEmbedding, instanceId, fetchLimit, ctx.dimensions).catch((err) => {
      console.error("Knowledge hybrid search: pgvector backend failed:", err);
      return [] as StoreResult[];
    }),
    searchByKeyword(query, instanceId, fetchLimit).catch((err) => {
      console.error("Knowledge hybrid search: FTS backend failed:", err);
      return [] as StoreResult[];
    }),
  ]);

  const K = 60;
  const scoreMap = new Map<string, { item: KnowledgeSearchResult; score: number }>();

  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const rrfScore = 1 / (K + i + 1);
    scoreMap.set(r.id, {
      item: { content: r.content, source: r.source, chunkIndex: r.chunkIndex, score: 0 },
      score: rrfScore,
    });
  }

  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const rrfScore = 1 / (K + i + 1);
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(r.id, {
        item: { content: r.content, source: r.source, chunkIndex: r.chunkIndex, score: 0 },
        score: rrfScore,
      });
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score: Math.round(score * 10000) / 10000 }));
}
