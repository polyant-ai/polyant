// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, MessageSquareCode, KeyRound, Eye, EyeOff, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MessageBubble } from "./message-bubble";
import { HookExecutionPill } from "@/components/messages/hook-execution-pill";
import { formatActivityTimestamp, parseUTC } from "@/lib/format";
import { ChatInput } from "./chat-input";
import { InstanceSelector } from "./instance-selector";
import { ChatHistoryDialog } from "./chat-sidebar";
import { DebugSheet, type DebugSheetTarget } from "@/components/messages/debug-sheet";
import { ContextStoreSheet } from "@/components/messages/context-store-sheet";
import { useI18n } from "@/lib/i18n/context";
import { useDetailedView } from "@/hooks/use-detailed-view";
import { useFollowBottom } from "@/hooks/use-follow-bottom";
import { JumpToLatest } from "@/components/messages/jump-to-latest";
import type { ChatMessage } from "../_hooks/use-chat";
import type { ConversationListItem, HookExecution } from "@/lib/api";

interface ChatAreaProps {
  messages: ChatMessage[];
  historicalHookExecutions: HookExecution[];
  isStreaming: boolean;
  instanceSlug: string;
  error: string | null;
  conversations: ConversationListItem[];
  conversationsLoading: boolean;
  activeConversationId: string | null;
  authToken: string;
  onAuthTokenChange: (token: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onInstanceChange: (slug: string) => void;
  onNewChat: () => void;
  onSelectConversation: (conversationId: string) => void;
}

export function ChatArea({
  messages,
  historicalHookExecutions,
  isStreaming,
  instanceSlug,
  error,
  conversations,
  conversationsLoading,
  activeConversationId,
  authToken,
  onAuthTokenChange,
  onSend,
  onStop,
  onInstanceChange,
  onNewChat,
  onSelectConversation,
}: ChatAreaProps) {
  const { t, locale } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [showKeyValue, setShowKeyValue] = useState(false);
  const [debugTarget, setDebugTarget] = useState<DebugSheetTarget | null>(null);
  const [stateOpen, setStateOpen] = useState(false);
  const [showActivity, setShowActivity] = useDetailedView();

  const timeline = useMemo(() => {
    const items: ({ kind: "message"; message: ChatMessage; ts: number } | { kind: "hook"; execution: HookExecution; ts: number })[] =
      messages.map((message) => ({ kind: "message", message, ts: message.createdAt ? parseUTC(message.createdAt).getTime() : Number.MAX_SAFE_INTEGER }));
    const oldestMessage = Math.min(...items.map((item) => item.ts));
    for (const execution of historicalHookExecutions) {
      const ts = parseUTC(execution.createdAt).getTime();
      if (ts >= oldestMessage) items.push({ kind: "hook", execution, ts });
    }
    return items.sort((a, b) => a.ts - b.ts);
  }, [messages, historicalHookExecutions]);

  // Follow the conversation as it grows, gliding while a reply streams in,
  // unless the reader has scrolled up to read something older.
  const { following, jumpToBottom } = useFollowBottom(scrollRef, true, timeline, { smooth: isStreaming });
  // Another conversation, or a new message of one's own, starts at the bottom
  // whatever was being read before.
  useEffect(() => {
    jumpToBottom();
  }, [activeConversationId, jumpToBottom]);
  const send = (text: string) => {
    jumpToBottom();
    onSend(text);
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* Header with instance selector + actions */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <InstanceSelector
          value={instanceSlug}
          onChange={onInstanceChange}
          disabled={isStreaming}
        />

        {/* Auth token inline input */}
        {showKeyInput && (
          <div className="relative flex-1 max-w-xs">
            <Input
              type={showKeyValue ? "text" : "password"}
              value={authToken}
              onChange={(e) => onAuthTokenChange(e.target.value)}
              placeholder={t("playground.authKeyPlaceholder")}
              className="h-8 pr-8 text-xs"
            />
            <button
              type="button"
              onClick={() => setShowKeyValue(!showKeyValue)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKeyValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="playground-activity" className="mr-2 flex items-center gap-2 text-sm font-normal text-muted-foreground">
            <Switch id="playground-activity" checked={showActivity} onCheckedChange={setShowActivity} />
            {t("conversations.detail.detailedToggle")}
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={authToken ? "default" : "ghost"}
                size="icon"
                className="size-8"
                onClick={() => setShowKeyInput(!showKeyInput)}
              >
                <KeyRound className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t("playground.authKeyToggle")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={!activeConversationId}
                onClick={() => setStateOpen(true)}
              >
                <Database className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("conversations.state.button")}</TooltipContent>
          </Tooltip>
          <ChatHistoryDialog
            conversations={conversations}
            loading={conversationsLoading}
            activeConversationId={activeConversationId}
            onSelectConversation={onSelectConversation}
          />
          <Button size="sm" onClick={onNewChat}>
            <Plus className="mr-2 size-4" />
            {t("playground.newChat")}
          </Button>
        </div>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[400px] flex-col items-center justify-center text-center">
            <MessageSquareCode className="size-12 text-muted-foreground/30" />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">
              {t("playground.title")}
            </h2>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              {t("playground.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 p-4">
            {timeline.map((item) => {
              if (item.kind === "hook") {
                return showActivity ? <HookExecutionPill key={`hook-${item.execution.id}`} execution={item.execution} timestamp={formatActivityTimestamp(item.execution.createdAt, locale)} /> : null;
              }
              const msg = item.message;
              const messageId = msg.dbMessageId ?? msg.id;
              // Inspect affordance only when we can address the persisted turn:
              // a known conversationId + a DB message id, and not the live stream.
              const canInspect =
                msg.role === "assistant" &&
                !msg.isStreaming &&
                !!activeConversationId &&
                !!messageId;
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  showActivity={showActivity}
                  onDebugClick={
                    canInspect
                      ? () =>
                          setDebugTarget({
                            conversationId: activeConversationId,
                            messageId,
                            instanceId: instanceSlug,
                          })
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
        {!following && <JumpToLatest onClick={jumpToBottom} />}
      </div>

      {/* Error */}
      {error && (
        <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Input */}
      <ChatInput
        onSend={send}
        onStop={onStop}
        isStreaming={isStreaming}
        disabled={!instanceSlug}
      />

      <DebugSheet
        open={debugTarget !== null}
        onOpenChange={(o) => !o && setDebugTarget(null)}
        target={debugTarget}
      />
      <ContextStoreSheet
        open={stateOpen}
        onOpenChange={setStateOpen}
        conversationId={activeConversationId}
        instanceId={instanceSlug}
      />
    </div>
  );
}
