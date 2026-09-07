// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface SaveAction {
  isDirty: boolean;
  saving: boolean;
  onSave: () => void | Promise<void>;
}

interface PageActionsContextValue {
  /**
   * The page's ONE save, aggregated over every form mounted in the section.
   * `null` when no form registered — which is how a list-only section (documents,
   * webhooks, MCP servers) ends up with no Save button at all.
   */
  saveAction: SaveAction | null;
  registerSaveAction: (id: string, action: SaveAction | null) => void;
}

const PageActionsContext = createContext<PageActionsContextValue | null>(null);

/**
 * ONE Save in the header, for however many forms the open section holds.
 *
 * It used to be a single slot: the last component to mount won it, and any other
 * form on the page silently lost its way to save. That was invisible while every
 * section held exactly one form — and it broke the moment two of them were merged
 * onto one page (Dati e privacy: the opt-out plus the retention window). A slot
 * that works only when nothing shares the page is a trap for the next merge, so
 * it registers per id and the header saves everything that is dirty.
 *
 * Sequential, not parallel: two forms on one page usually write the same agent,
 * and concurrent PATCHes to one row are how one of them ends up overwritten by a
 * stale copy of the other's fields.
 */
export function PageActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<Record<string, SaveAction>>({});

  const registerSaveAction = useCallback((id: string, action: SaveAction | null) => {
    setActions((prev) => {
      if (action === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: action };
    });
  }, []);

  const saveAction = useMemo<SaveAction | null>(() => {
    const entries = Object.values(actions);
    if (entries.length === 0) return null;
    return {
      isDirty: entries.some((a) => a.isDirty),
      saving: entries.some((a) => a.saving),
      onSave: async () => {
        for (const action of entries) {
          if (action.isDirty) await action.onSave();
        }
      },
    };
  }, [actions]);

  return (
    <PageActionsContext.Provider value={{ saveAction, registerSaveAction }}>
      {children}
    </PageActionsContext.Provider>
  );
}

export function usePageActions() {
  const ctx = useContext(PageActionsContext);
  if (!ctx) {
    throw new Error("usePageActions must be used within PageActionsProvider");
  }
  return ctx;
}

export function usePageSaveAction({ isDirty, saving, onSave }: SaveAction) {
  const { registerSaveAction } = usePageActions();
  const id = useId();
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    registerSaveAction(id, {
      isDirty,
      saving,
      onSave: () => onSaveRef.current(),
    });
    return () => registerSaveAction(id, null);
  }, [id, isDirty, saving, registerSaveAction]);
}
