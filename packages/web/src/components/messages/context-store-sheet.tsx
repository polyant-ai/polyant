// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * ContextStoreSheet
 *
 * Conversation-level right-side panel showing the shared conversation state store
 * snapshot (the `conversation_state` blob, including the server-seeded `_channel`
 * identity). Fetched on-demand. This is the latest snapshot — the state store is
 * not versioned per turn.
 *
 * Shared by the playground and the conversation-detail page.
 */

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { api } from "@/lib/api";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface ContextStoreSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Conversation to load state for. Null disables fetching. */
  conversationId: string | null;
  agentId: string;
}

export function ContextStoreSheet({ open, onOpenChange, conversationId, agentId }: ContextStoreSheetProps) {
  const { t } = useI18n();
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open || !conversationId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setState(null);
    api.conversations
      .state(conversationId, agentId)
      .then((res) => {
        if (!cancelled) setState(res.state);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, conversationId, agentId]);

  const isEmpty = state != null && Object.keys(state).length === 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("conversations.state.title")}</SheetTitle>
          <SheetDescription>{t("conversations.state.description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 px-4 pb-8">
          {loading && <p className="text-sm text-muted-foreground">{t("conversations.state.loading")}</p>}
          {error && <p className="text-sm text-destructive">{t("conversations.state.error")}</p>}
          {!loading && !error && isEmpty && (
            <p className="text-sm text-muted-foreground">{t("conversations.state.empty")}</p>
          )}
          {!loading && !error && state != null && !isEmpty && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed">
              {JSON.stringify(state, null, 2)}
            </pre>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
