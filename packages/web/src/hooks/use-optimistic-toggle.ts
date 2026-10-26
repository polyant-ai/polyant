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
  const chosenRef = useRef(chosen);
  useEffect(() => {
    scopeRef.current = scope;
    chosenRef.current = chosen;
  });

  /** The position to show for `key`, given the one the rows hold. */
  const value = useCallback((key: string, saved: boolean) => chosen[key] ?? saved, [chosen]);

  /**
   * Show `next` for `key`, run `commit`, and on failure show the position that was
   * on screen before the click (a toggle that succeeded earlier moved it away from
   * the rows) and pass the error to `onError` (when still on the same scope).
   */
  const toggle = useCallback(
    async (key: string, next: boolean, commit: () => Promise<unknown>, onError: (err: unknown) => void) => {
      const sentFrom = scopeRef.current;
      const before = chosenRef.current[key];
      chosenRef.current = { ...chosenRef.current, [key]: next };
      setState((prev) => ({
        source,
        scope: sentFrom,
        chosen: { ...(prev.source === source && prev.scope === sentFrom ? prev.chosen : NONE), [key]: next },
      }));
      try {
        await commit();
      } catch (err) {
        if (scopeRef.current !== sentFrom) return;
        const restoredRef = { ...chosenRef.current };
        if (before === undefined) delete restoredRef[key];
        else restoredRef[key] = before;
        chosenRef.current = restoredRef;
        setState((prev) => {
          if (prev.source !== source || prev.scope !== sentFrom) return prev;
          const restored = { ...prev.chosen };
          if (before === undefined) delete restored[key];
          else restored[key] = before;
          return { ...prev, chosen: restored };
        });
        onError(err);
      }
    },
    [source],
  );

  return { value, toggle };
}
