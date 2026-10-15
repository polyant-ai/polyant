// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * State that survives a reload in `localStorage`, for a reader's own
 * conveniences (a view mode, a filter) and never for anything that must be shared
 * or reliable.
 *
 * Storage can be missing or throw (private window, blocked site data), so every
 * access is guarded and the state still works without it. The stored value is read
 * after mount rather than in the initial render, so server and client render the
 * same first frame. `parse` turns the raw string into a value or returns
 * `undefined` to reject it (a stale or hand-edited entry); `serialize` defaults
 * to `String`.
 */
export function usePersistedState<T>(
  storageKey: string,
  initial: T,
  parse: (raw: string) => T | undefined,
  serialize: (value: T) => string = String,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw === null ? undefined : parse(raw);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading browser storage after mount is the point
      if (parsed !== undefined) setValue(parsed);
    } catch {
      /* no storage: keep the initial value */
    }
    // `parse` is a pure decoder the caller may declare inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, serialize(next));
      } catch {
        /* no storage: the value lives for this visit only */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey],
  );

  return [value, set];
}
