// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n/context";
import type { ConversationListItem } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ChatHistoryDialogProps {
  conversations: ConversationListItem[];
  loading: boolean;
  activeConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d`;
  return date.toLocaleDateString();
}

export function ChatHistoryDialog({
  conversations,
  loading,
  activeConversationId,
  onSelectConversation,
}: ChatHistoryDialogProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const handleSelect = (conversationId: string) => {
    onSelectConversation(conversationId);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="mr-2 size-4" />
          {t("playground.history")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("playground.historyTitle")}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          {loading ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-sm" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-muted-foreground">
                {t("playground.noConversations")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("playground.noConversationsHint")}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {conversations.map((conv) => {
                const isActive =
                  activeConversationId === conv.conversationId;
                const displayTitle = conv.title
                  ?? (conv.summary && conv.summary.length > 60
                    ? conv.summary.slice(0, 60) + "..."
                    : conv.summary ?? t("playground.newChat"));

                return (
                  <button
                    key={conv.conversationId}
                    onClick={() => handleSelect(conv.conversationId)}
                    className={cn(
                      "w-full rounded-sm px-3 py-3 text-left transition-colors hover:bg-secondary",
                      isActive && "bg-secondary",
                    )}
                  >
                    <p className="text-sm font-medium line-clamp-1">{displayTitle}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      {conv.agentName && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                          {conv.agentName}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {conv.messageCount} msg
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTime(conv.updatedAt)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
