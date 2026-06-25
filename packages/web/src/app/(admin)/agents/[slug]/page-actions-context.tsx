// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  saveAction: SaveAction | null;
  setSaveAction: (action: SaveAction | null) => void;
}

const PageActionsContext = createContext<PageActionsContextValue | null>(null);

export function PageActionsProvider({ children }: { children: ReactNode }) {
  const [saveAction, setSaveActionState] = useState<SaveAction | null>(null);
  const setSaveAction = useCallback(
    (action: SaveAction | null) => setSaveActionState(action),
    [],
  );

  return (
    <PageActionsContext.Provider value={{ saveAction, setSaveAction }}>
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
  const { setSaveAction } = usePageActions();
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    setSaveAction({
      isDirty,
      saving,
      onSave: () => onSaveRef.current(),
    });
    return () => setSaveAction(null);
  }, [isDirty, saving, setSaveAction]);
}
