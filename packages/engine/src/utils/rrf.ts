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
  const scoreMap = new Map<string, { item: Item; score: number }>();
  for (const list of lists) {
    list.rows.forEach((row, i) => {
      const rrfScore = 1 / (RRF_K + i + 1);
      const key = list.keyOf(row);
      const existing = scoreMap.get(key);
      if (existing) existing.score += rrfScore;
      else scoreMap.set(key, { item: list.toItem(row), score: rrfScore });
    });
  }
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score: Math.round(score * 10000) / 10000 }));
}
