// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

const STORAGE_PREFIX = "playground_auth_";

function readStored(slug: string): string {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${slug}`) ?? "";
  } catch {
    return "";
  }
}

/**
 * The agent's key for the playground. The engine says whether this user needs
 * one (read access without write access, on an agent with authentication on);
 * the panel holds no permissions of its own. The typed key is kept per agent in
 * localStorage, as the playground did before it had its own route.
 */
export function useAgentKey(instanceSlug: string) {
  const [keyRequired, setKeyRequired] = useState(false);
  const [key, setKeyState] = useState("");

  useEffect(() => {
    setKeyRequired(false);
    setKeyState(instanceSlug ? readStored(instanceSlug) : "");
    if (!instanceSlug) return;
    let current = true;
    api.instances.playgroundAccess(instanceSlug).then(
      (access) => { if (current) setKeyRequired(access.keyRequired); },
      () => { /* no answer: the field stays hidden and a refused turn reports itself */ },
    );
    return () => { current = false; };
  }, [instanceSlug]);

  const setKey = useCallback(
    (next: string) => {
      setKeyState(next);
      if (!instanceSlug) return;
      try {
        if (next) localStorage.setItem(`${STORAGE_PREFIX}${instanceSlug}`, next);
        else localStorage.removeItem(`${STORAGE_PREFIX}${instanceSlug}`);
      } catch { /* storage unavailable: the key lasts for this page only */ }
    },
    [instanceSlug],
  );

  return { keyRequired, key, setKey };
}
