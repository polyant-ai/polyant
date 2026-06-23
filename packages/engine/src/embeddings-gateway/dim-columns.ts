// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmbeddingDim } from "./types.js";

/**
 * Vector-column assignment for tables that carry both 1536- and 1024-dim
 * parallel columns (memories, knowledge_chunks). Exactly one column is
 * populated per row — the one that matches the active embedding dimension —
 * and the other is explicitly nulled so the DB XOR check constraint holds.
 */
export function vectorColumnValues(
  dim: EmbeddingDim,
  embedding: number[] | null,
): { embedding: number[] | null; embedding1024: number[] | null } {
  if (dim === 1024) return { embedding: null, embedding1024: embedding };
  return { embedding, embedding1024: null };
}
