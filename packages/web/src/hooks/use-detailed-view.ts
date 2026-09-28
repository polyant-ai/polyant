// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "conversationDetailedView";
const listeners = new Set<() => void>();
// Fallback when storage is blocked, so the switch still works for the session.
let memory = false;

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return memory;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * The "detailed view" switch shared by Conversations and Playground: one
 * preference, so activity turned on in one place shows in the other, live
 * turns included. The server snapshot is `false`, so SSR never mismatches.
 */
export function useDetailedView(): [boolean, (value: boolean) => void] {
  const detailed = useSyncExternalStore(subscribe, read, () => false);

  const update = useCallback((value: boolean) => {
    memory = value;
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Storage unavailable: `memory` carries the value.
    }
    for (const listener of listeners) listener();
  }, []);

  return [detailed, update];
}
