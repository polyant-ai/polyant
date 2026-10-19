// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useParams } from "next/navigation";
import { api, type ConversationListItem } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";

const PAGE_SIZE = 30;
const NONE: ConversationListItem[] = [];

export function useConversations() {
  const { orgSlug, workspaceSlug } = useParams<{ orgSlug: string; workspaceSlug: string }>();
  // A failed read leaves the sidebar on its empty state.
  const { data, loading, reload } = useResource(["playground-conversations", orgSlug, workspaceSlug], () =>
    api.conversations
      .list({ limit: PAGE_SIZE })
      .then((result) => result.conversations)
      .catch(() => NONE),
  );

  return { conversations: data ?? NONE, loading: loading && data === undefined, refresh: reload };
}
