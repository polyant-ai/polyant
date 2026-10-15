// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  /** The last answer for the CURRENT key; undefined until it arrives. Kept while a reload runs. */
  data: T | undefined;
  /** The failure of the current key's last attempt, cleared when a new one starts. */
  error: unknown;
  /** True from a key change (or a reload) until its answer settles. */
  loading: boolean;
  /** Ask again for the same key; the held data stays visible meanwhile. */
  reload: () => void;
}

interface Settled<T> {
  key: string;
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
 */
export function useResource<T>(
  key: string | readonly unknown[] | null,
  fetcher: () => Promise<T>,
): Resource<T> {
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
        if (!stale) setSettled({ key: keyString, attempt, data, failed: false });
      })
      .catch((error: unknown) => {
        if (!stale) setSettled((prev) => ({ key: keyString, attempt, data: prev?.key === keyString ? prev.data : undefined, error, failed: true }));
      });
    return () => {
      stale = true;
    };
  }, [keyString, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const forKey = settled !== null && settled.key === keyString;
  const current = forKey && settled.attempt === attempt;
  return {
    data: forKey ? settled.data : undefined,
    error: current && settled.failed ? settled.error : undefined,
    loading: keyString !== null && !current,
    reload,
  };
}
