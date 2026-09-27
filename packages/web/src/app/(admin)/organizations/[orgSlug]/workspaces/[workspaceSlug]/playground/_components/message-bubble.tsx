// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { SearchCode } from "lucide-react";
import { MarkdownRenderer } from "./markdown-renderer";
import { MessageExtras } from "@/components/messages/message-extras";
import { HookExecutionPill } from "@/components/messages/hook-execution-pill";
import { SystemActivity } from "@/components/messages/system-activity";
import { useI18n } from "@/lib/i18n/context";
import { formatActivityTimestamp } from "@/lib/format";
import type { ChatMessage } from "../_hooks/use-chat";

interface MessageBubbleProps {
  message: ChatMessage;
  showActivity: boolean;
  onDebugClick?: () => void;
}

export function MessageBubble({ message, showActivity, onDebugClick }: MessageBubbleProps) {
  const { t, locale } = useI18n();
  const isUser = message.role === "user";
  if (message.role === "system") {
    return showActivity ? (
      <div className="max-w-[85%]">
        <SystemActivity content={message.content} timestamp={message.createdAt ? formatActivityTimestamp(message.createdAt, locale) : undefined} />
      </div>
    ) : null;
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`${isUser ? "max-w-[75%]" : "max-w-[85%]"} min-w-0`}>
        {!isUser && showActivity && (message.hookExecutions.length > 0 || message.reasoning.length > 0 || message.steps.some((step) => step.toolCalls.length > 0)) && (
          <div className="mb-3">
            {message.hookExecutions.length > 0 && <div className="border-l border-border pl-3">
              {message.hookExecutions.map((exec, i) => (
                <HookExecutionPill key={`${exec.hookId}-${exec.event}-${i}`} execution={exec} />
              ))}
            </div>}
            <MessageExtras reasoning={message.reasoning} steps={message.steps} />
          </div>
        )}
        <div className={`min-w-0 overflow-hidden break-words rounded-2xl px-4 py-3 ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}>
          {isUser ? (
            <p className="whitespace-pre-wrap text-sm">{message.content}</p>
          ) : message.content ? (
            <div className="text-sm"><MarkdownRenderer content={message.content} /></div>
          ) : message.isStreaming ? (
            <div className="flex items-center gap-1 py-1">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
            </div>
          ) : null}
          {message.createdAt && !message.isStreaming && (
            <div className={`mt-1 flex items-center gap-1.5 text-xs ${isUser ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
              <time>{formatActivityTimestamp(message.createdAt, locale)}</time>
              {!isUser && onDebugClick && (
                <button type="button" onClick={onDebugClick} className="inline-flex items-center gap-1 rounded px-1 transition hover:text-foreground" title={t("message.debug.open")}>
                  <SearchCode className="size-3" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
