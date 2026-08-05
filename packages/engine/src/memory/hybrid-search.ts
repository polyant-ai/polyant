// SPDX-License-Identifier: AGPL-3.0-or-later

import { searchByVector } from "./memory-store.js";
import { embed, resolveEmbeddingContext } from "../embeddings-gateway/index.js";
import { conversationStore } from "../conversations/index.js";
import { DEFAULT_INSTANCE_ID } from "../config.js";
import { memoryLog } from "./memory-logger.js";
import { asInstanceSlug, type InstanceSlug } from "../instances/identifiers.js";

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
  instanceId?: InstanceSlug,
  limit = 10,
): Promise<HybridSearchResult[]> {
  const uid = instanceId ?? asInstanceSlug(DEFAULT_INSTANCE_ID);
  const fetchLimit = Math.max(limit * 2, 20);

  // Generate embedding for the query via the provider-aware gateway
  const ctx = await resolveEmbeddingContext(uid);
  const queryEmbedding = await embed(query, ctx);

  // Run both backends in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    searchByVector(queryEmbedding, uid, fetchLimit, ctx.dimensions).catch((err) => {
      memoryLog.error("HybridSearch", "pgvector semantic search failed:", err);
      return [];
    }),
    conversationStore.searchByKeyword(query, uid, fetchLimit).catch((err) => {
      memoryLog.error("HybridSearch", "PostgreSQL keyword search failed:", err);
      return [];
    }),
  ]);

  // RRF fusion
  const K = 60;
  const scoreMap = new Map<string, { item: HybridSearchResult; score: number }>();

  // Score semantic results with RRF
  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const key = `mem:${r.id}`;
    const rrfScore = 1 / (K + i + 1);
    scoreMap.set(key, {
      item: {
        content: r.content,
        type: "memory",
        score: 0,
        source: r.id,
        createdAt: r.createdAt?.toISOString() ?? "",
      },
      score: rrfScore,
    });
  }

  // Score keyword results with RRF
  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const key = `pg:${r.id}`;
    const rrfScore = 1 / (K + i + 1);
    const existing = scoreMap.get(key);
    if (existing) {
      // Same document found in both backends — sum the RRF scores
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, {
        item: {
          content: r.content,
          type: "conversation",
          score: 0,
          source: r.id,
          createdAt: r.createdAt?.toISOString() ?? "",
        },
        score: rrfScore,
      });
    }
  }

  // Sort by fused RRF score, return top N
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score: Math.round(score * 10000) / 10000 }));
}
