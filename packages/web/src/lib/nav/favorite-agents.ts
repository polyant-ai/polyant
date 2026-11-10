// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, getUserErrorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

/**
 * The agents a person has starred, by agent id, listed at the foot of the daily
 * sidebar. They belong to the person (`/api/me/favorite-agents`), so they follow
 * them across devices; one copy per page load, read once and kept in step with
 * every star clicked here.
 *
 * A star grants nothing: whoever shows the list keeps only the agents it already
 * holds for the workspace on screen.
 */

const NONE: readonly string[] = [];

let ids: readonly string[] = NONE;
let loading: Promise<void> | null = null;
/** Bumped by every star clicked; an answer that a later click overtook is not applied. */
let revision = 0;
const listeners = new Set<() => void>();

function publish(next: readonly string[]): void {
  ids = next;
  for (const listener of listeners) listener();
}

function load(): void {
  if (loading) return;
  const startedAt = revision;
  loading = api.me
    .favoriteAgents()
    .then(({ agentIds }) => {
      if (revision === startedAt) publish(agentIds);
    })
    .catch(() => {
      // Nothing to show, and the stars read as off. A later mount asks again.
      loading = null;
    });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The new list with `agentId` put in or taken out, leaving the others as they are. */
function withStar(list: readonly string[], agentId: string, on: boolean): readonly string[] {
  const without = list.filter((id) => id !== agentId);
  return on ? [...without, agentId] : without;
}

async function toggleStar(agentId: string, onError: (err: unknown) => void): Promise<void> {
  const on = !ids.includes(agentId);
  const mine = ++revision;
  publish(withStar(ids, agentId, on));
  try {
    const { agentIds } = on ? await api.me.addFavoriteAgent(agentId) : await api.me.removeFavoriteAgent(agentId);
    if (revision === mine) publish(agentIds);
  } catch (err) {
    // Take back this star only; another clicked meanwhile keeps its position.
    publish(withStar(ids, agentId, !on));
    onError(err);
  }
}

/**
 * Drop the copy read from the engine, so the next mount reads it again. A page
 * load starts this way; tests call it to start from one.
 */
export function forgetFavoriteAgents(): void {
  loading = null;
  revision++;
  publish(NONE);
}

export function useFavoriteAgents(): {
  ids: readonly string[];
  isFavorite: (agentId: string) => boolean;
  toggle: (agentId: string) => void;
} {
  const { t } = useI18n();
  const current = useSyncExternalStore(subscribe, () => ids, () => NONE);
  useEffect(load, []);
  const isFavorite = useCallback((agentId: string) => current.includes(agentId), [current]);
  const toggle = useCallback(
    (agentId: string) => {
      void toggleStar(agentId, (err) => toast.error(getUserErrorMessage(err, t("instances.favorite.failed"))));
    },
    [t],
  );
  return { ids: current, isFavorite, toggle };
}
