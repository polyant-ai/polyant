// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  /** The last answer for the CURRENT key (or, with `keepPreviousWithin`, the previous one until it arrives); undefined until it arrives. Kept while a reload runs. */
  data: T | undefined;
  /** The failure of the current key's last attempt, cleared when a new one starts. */
  error: unknown;
  /** True from a key change (or a reload) until its answer settles. */
  loading: boolean;
  /** Ask again for the same key; the held data stays visible meanwhile. */
  reload: () => void;
  /**
   * Change the held data without asking the engine, for a result the engine has
   * just confirmed (a row it deleted). Pair it with `reload`, whose answer then
   * replaces the local change. Does nothing while there is no data.
   */
  mutate: (update: (data: T) => T) => void;
}

interface Settled<T> {
  key: string;
  /** The `keepPreviousWithin` value in force when it settled. */
  within?: string;
  attempt: number;
  data?: T;
  error?: unknown;
  failed: boolean;
}

/**
 * Load one thing from the engine and keep it in step with a key.
 *
 * Pass a fetcher that calls the `api` client (never `fetch`), so the tenant
 * in the URL stays the tenant acted on. The key names what is asked for: when
 * it changes the previous answer is dropped and the new one loaded, and an
 * answer that arrives for an old key (or after unmount) is ignored, so a slow
 * response can never overwrite a fresher one. `null` means "nothing to load
 * yet", for a fetch that waits on an input.
 *
 * `loading` and the matching of an answer to its key are derived from what has
 * settled, not kept as flags the effect lowers, so they cannot disagree with
 * the data they describe.
 *
 * `keepPreviousWithin` keeps the last answer on screen while the next key loads,
 * for a list that moves between pages or filters without emptying itself. The
 * previous answer is kept only while that value stays the same: pass what the
 * held data must never cross (the workspace), so rows of one never show under
 * another.
 */
export function useResource<T>(
  key: string | readonly unknown[] | null,
  fetcher: () => Promise<T>,
  options?: { keepPreviousWithin?: string },
): Resource<T> {
  const within = options?.keepPreviousWithin;
  const keyString = key === null ? null : typeof key === "string" ? key : JSON.stringify(key);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (keyString === null) return;
    let stale = false;
    fetcherRef
      .current()
      .then((data) => {
        if (!stale) setSettled({ key: keyString, within, attempt, data, failed: false });
      })
      .catch((error: unknown) => {
        if (!stale) setSettled((prev) => ({ key: keyString, within, attempt, data: prev?.key === keyString ? prev.data : undefined, error, failed: true }));
      });
    return () => {
      stale = true;
    };
  }, [keyString, attempt, within]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const mutate = useCallback(
    (update: (data: T) => T) =>
      setSettled((prev) => (prev !== null && prev.key === keyString && prev.data !== undefined ? { ...prev, data: update(prev.data) } : prev)),
    [keyString],
  );
  const forKey = settled !== null && settled.key === keyString;
  const current = forKey && settled.attempt === attempt;
  const kept = !forKey && keyString !== null && within !== undefined && settled?.within === within;
  return {
    data: forKey || kept ? settled?.data : undefined,
    error: current && settled.failed ? settled.error : undefined,
    loading: keyString !== null && !current,
    reload,
    mutate,
  };
}
