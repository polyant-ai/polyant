// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { usePersistedState } from "@/hooks/use-persisted-state";

const STORAGE_KEY = "activity-instance-filter-excluded";
const EMPTY = new Set<string>();

/** A stale or corrupt entry is rejected, which leaves the empty selection. */
function parseExcluded(raw: string): Set<string> | undefined {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : undefined;
}

const serializeExcluded = (ids: Set<string>) => JSON.stringify([...ids]);

/**
 * Persist the set of instance IDs whose events should be HIDDEN from the
 * activity feed. Storing exclusions (rather than inclusions) means new
 * instances appear by default — the user only has to opt-out, never opt-in.
 */
export function useInstanceFilter(): {
  excluded: Set<string>;
  toggle: (id: string) => void;
  setAll: (ids: string[]) => void;
  clear: () => void;
  hydrated: boolean;
} {
  const [excluded, setExcluded] = usePersistedState<Set<string>>(STORAGE_KEY, EMPTY, parseExcluded, serializeExcluded);
  // Set in the effect that follows the storage read, so both land in one render.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the end of the first storage read
    setHydrated(true);
  }, []);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(excluded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExcluded(next);
    },
    [excluded, setExcluded],
  );

  /** Mark every given id as excluded (used for "deselect all"). */
  const setAll = useCallback(
    (ids: string[]) => {
      setExcluded(new Set(ids));
    },
    [setExcluded],
  );

  /** Clear exclusions — show every instance ("select all"). */
  const clear = useCallback(() => {
    setExcluded(new Set());
  }, [setExcluded]);

  return { excluded, toggle, setAll, clear, hydrated };
}
