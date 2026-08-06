// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "activity-instance-filter-excluded";

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
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setExcluded(new Set(parsed.filter((v): v is string => typeof v === "string")));
        }
      }
    } catch {
      // ignore corrupt storage — start with empty selection
    }
    setHydrated(true);
  }, []);

  const persist = useCallback((next: Set<string>) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    setExcluded(next);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(excluded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
    },
    [excluded, persist],
  );

  /** Mark every given id as excluded (used for "deselect all"). */
  const setAll = useCallback(
    (ids: string[]) => {
      persist(new Set(ids));
    },
    [persist],
  );

  /** Clear exclusions — show every instance ("select all"). */
  const clear = useCallback(() => {
    persist(new Set());
  }, [persist]);

  return { excluded, toggle, setAll, clear, hydrated };
}
