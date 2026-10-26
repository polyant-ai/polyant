// SPDX-License-Identifier: AGPL-3.0-or-later

import { matchesSearch } from "@/components/list-search";

/**
 * The rows a list shows: those matching the search box, sorted by their visible
 * name. Every list filtered and sorted by hand, each slightly differently; this
 * is the one way.
 *
 * - `searchText` returns the row's visible text (name, the line under it, badge
 *   text); every word typed must appear in it, in any order.
 * - `sortKey` returns what the rows are ordered by, compared with `localeCompare`.
 *   Pass `null` to keep the order given, for a list that has a meaningful one
 *   (newest first, execution order).
 *
 * The input is never mutated.
 */
export function useListView<T>(
  rows: readonly T[],
  query: string,
  searchText: (row: T) => ReadonlyArray<string | null | undefined>,
  sortKey: ((row: T) => string) | null,
): T[] {
  const matching = rows.filter((row) => matchesSearch(query, ...searchText(row)));
  return sortKey ? matching.sort((a, b) => sortKey(a).localeCompare(sortKey(b))) : matching;
}
