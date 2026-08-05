// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useActivityStreamContext } from "@/lib/activity-stream/provider";
import type { FeedEvent } from "@/lib/activity-stream/types";

interface UseActivityStreamResult {
  events: FeedEvent[];
  realLive: boolean;
  error: string | null;
}

/**
 * Read the live activity stream from the shared Context provider.
 * The SSE connection itself is owned by `<ActivityStreamProvider>` mounted
 * in the admin layout — this hook is a thin wrapper over the context for
 * list-shaped consumers (the `/activity` page).
 */
export function useActivityStream(): UseActivityStreamResult {
  const { events, realLive, error } = useActivityStreamContext();
  return { events, realLive, error };
}
