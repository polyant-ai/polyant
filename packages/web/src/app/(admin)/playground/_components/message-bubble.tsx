// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Terminal, SearchCode } from "lucide-react";
import { MarkdownRenderer } from "./markdown-renderer";
import { MessageExtras } from "@/components/messages/message-extras";
import { useI18n } from "@/lib/i18n/context";
import type { ChatMessage } from "../_hooks/use-chat";

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  // parseUTC not needed here — playground timestamps are generated client-side with toISOString() (already has Z)
  return new Date(dateStr).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface MessageBubbleProps {
  message: ChatMessage;
  /** When provided, an "inspect turn" affordance opens the debug panel for this message. */
  onDebugClick?: () => void;
}

export function MessageBubble({ message, onDebugClick }: MessageBubbleProps) {
  const { t } = useI18n();
  const isUser = message.role === "user";

  // System message → centered amber pill
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="max-w-[85%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-start gap-2">
            <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="whitespace-pre-wrap text-sm text-amber-800 dark:text-amber-200">
                {message.content}
              </p>
              {message.createdAt && (
                <p className="mt-1 text-xs text-amber-600/60 dark:text-amber-400/60">
                  {formatTime(message.createdAt)}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] min-w-0 overflow-hidden break-words rounded-2xl px-4 py-3 ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        {/* Reasoning + steps panels above assistant text. Default closed in
            playground (clean live UX); conversations page passes defaultOpen=true. */}
        {!isUser && (
          <MessageExtras
            reasoning={message.reasoning}
            steps={message.steps}
            defaultOpen={false}
          />
        )}

        {/* Message content */}
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        ) : message.content ? (
          <div className="text-sm">
            <MarkdownRenderer content={message.content} />
          </div>
        ) : message.isStreaming ? (
          <div className="flex items-center gap-1 py-1">
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
          </div>
        ) : null}

        {/* Timestamp + (assistant only) inspect-turn affordance */}
        {message.createdAt && !message.isStreaming && (
          <div
            className={`mt-1 flex items-center gap-1.5 text-xs ${
              isUser ? "text-primary-foreground/60" : "text-muted-foreground"
            }`}
          >
            <span>{formatTime(message.createdAt)}</span>
            {!isUser && onDebugClick && (
              <button
                type="button"
                onClick={onDebugClick}
                className="inline-flex items-center gap-1 rounded px-1 transition hover:text-foreground"
                title={t("message.debug.open")}
              >
                <SearchCode className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
