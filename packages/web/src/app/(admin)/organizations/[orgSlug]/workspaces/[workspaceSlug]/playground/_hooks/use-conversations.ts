// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type ConversationListItem } from "@/lib/api";

const PAGE_SIZE = 30;

export function useConversations() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const result = await api.conversations.list({ limit: PAGE_SIZE });
      setConversations(result.conversations);
    } catch {
      // Silently fail — sidebar will show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  const refresh = useCallback(() => {
    fetch_();
  }, [fetch_]);

  return { conversations, loading, refresh };
}
