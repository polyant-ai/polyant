// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const NONE: Readonly<Record<string, boolean>> = {};

/**
 * Switches that show the new position at once and take it back if the engine
 * refuses.
 *
 * `source` is whatever the rows were read from (a `useResource` answer): while
 * the engine has not confirmed, `value(key, saved)` answers the chosen position
 * instead of the stored one, and when a fresh `source` arrives the choices are
 * dropped, because the rows now say what the engine holds. `scope` names where the
 * toggle was sent from (the tenant route): a rollback belongs to that place, so a
 * failure that arrives after the reader moved on neither undoes nor reports
 * anything over the rows now on screen.
 */
export function useOptimisticToggle(source: unknown, scope: string) {
  const [state, setState] = useState<{ source: unknown; scope: string; chosen: Readonly<Record<string, boolean>> }>({
    source,
    scope,
    chosen: NONE,
  });
  const chosen = state.source === source && state.scope === scope ? state.chosen : NONE;

  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  });

  /** The position to show for `key`, given the one the rows hold. */
  const value = useCallback((key: string, saved: boolean) => chosen[key] ?? saved, [chosen]);

  /**
   * Show `next` for `key`, run `commit`, and on failure show the old position again
   * and pass the error to `onError` (when still on the same scope).
   */
  const toggle = useCallback(
    async (key: string, next: boolean, commit: () => Promise<unknown>, onError: (err: unknown) => void) => {
      const sentFrom = scopeRef.current;
      setState((prev) => ({
        source,
        scope: sentFrom,
        chosen: { ...(prev.source === source && prev.scope === sentFrom ? prev.chosen : NONE), [key]: next },
      }));
      try {
        await commit();
      } catch (err) {
        if (scopeRef.current !== sentFrom) return;
        setState((prev) => {
          const rest = { ...prev.chosen };
          delete rest[key];
          return { ...prev, chosen: rest };
        });
        onError(err);
      }
    },
    [source],
  );

  return { value, toggle };
}
