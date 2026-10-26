// SPDX-License-Identifier: AGPL-3.0-or-later

/** Standard Reciprocal Rank Fusion constant. */
const RRF_K = 60;

/** One ranked backend result list: its rows, in rank order, and how to key and shape them. */
export interface RankedList<Row, Item> {
  rows: readonly Row[];
  /** Identity across lists: rows with the same key are the same document and their scores add up. */
  keyOf: (row: Row) => string;
  /** The result item for a row; the first list to carry a key supplies it. */
  toItem: (row: Row) => Item;
  /**
   * How authoritative this list is when two rows tie on fused score (lower
   * wins). When any list carries one, ties go to the lowest rank a row appeared
   * under and then to the key, so the order is reproducible; without ranks the
   * order of equal scores is the order the rows were first seen.
   */
  rank?: number;
}

/**
 * Reciprocal Rank Fusion: each row scores 1/(k + rank + 1) in every list it
 * appears in, scores add up per key, and the top `limit` come back best first
 * with the score rounded to four decimals. Rankings from heterogeneous
 * backends fuse without normalising their native scores.
 */
export function reciprocalRankFusion<Item extends { score: number }>(
  lists: readonly RankedList<any, Item>[],
  limit: number,
): Item[] {
  const scoreMap = new Map<string, { item: Item; score: number; rank: number; key: string }>();
  for (const list of lists) {
    const rank = list.rank ?? 0;
    list.rows.forEach((row, i) => {
      const rrfScore = 1 / (RRF_K + i + 1);
      const key = list.keyOf(row);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
        existing.rank = Math.min(existing.rank, rank);
      } else {
        scoreMap.set(key, { item: list.toItem(row), score: rrfScore, rank, key });
      }
    });
  }
  const ranked = lists.some((l) => l.rank !== undefined);
  return Array.from(scoreMap.values())
    .sort(
      (a, b) =>
        b.score - a.score ||
        (ranked ? a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : 0),
    )
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score: Math.round(score * 10000) / 10000 }));
}
