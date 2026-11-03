// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";

interface UsePaginationOptions {
  pageSize?: number;
  debounceMs?: number;
}

interface UsePaginationReturn {
  page: number;
  setPage: (page: number | ((prev: number) => number)) => void;
  search: string;
  setSearch: (value: string) => void;
  debouncedSearch: string;
  offset: number;
}

export function usePagination(opts: UsePaginationOptions = {}): UsePaginationReturn {
  const { pageSize = 20, debounceMs = 400 } = opts;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input and reset to page 1. Only when the search actually
  // changed: on mount it has not, and a reset then would undo a page the reader
  // chose within the first debounce interval.
  useEffect(() => {
    if (search === debouncedSearch) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [search, debouncedSearch, debounceMs]);

  const offset = (page - 1) * pageSize;

  return {
    page,
    setPage,
    search,
    setSearch,
    debouncedSearch,
    offset,
  };
}
