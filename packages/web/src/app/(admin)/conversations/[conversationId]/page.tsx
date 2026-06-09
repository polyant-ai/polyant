// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Trash2, Loader2, Info, Zap, Coins, Terminal, FileText, Mic, SearchCode, Database } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, getUserErrorMessage, type ConversationListItem, type ConversationMessage, type AttachmentMeta } from "@/lib/api";
import { MarkdownRenderer } from "@/app/(admin)/playground/_components/markdown-renderer";
import { MessageExtras } from "@/components/messages/message-extras";
import { DebugSheet, type DebugSheetTarget } from "@/components/messages/debug-sheet";
import { ContextStoreSheet } from "@/components/messages/context-store-sheet";
import { formatRelativeTime, parseUTC } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

const MESSAGES_PAGE_SIZE = 50;

/**
 * Per-message timestamp. Strategy:
 *  - same calendar day  → "14:30:25"
 *  - yesterday          → "ieri / yesterday 14:30:25" (Intl.RelativeTimeFormat picks the locale)
 *  - within last 6 days → "lun 14:30:25"
 *  - same year          → "22 mag 14:30:25"
 *  - older              → "22 mag 2024 14:30:25"
 * The locale is the browser's default — same approach as the rest of the page.
 */
function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = parseUTC(dateStr);
  const now = new Date();

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (sameDay(date, now)) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) {
    const label = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-1, "day");
    return `${label} ${time}`;
  }

  // Within the last 6 days: show weekday abbreviation (lun/tue/…).
  const sixDaysAgo = new Date(now);
  sixDaysAgo.setDate(now.getDate() - 6);
  sixDaysAgo.setHours(0, 0, 0, 0);
  if (date >= sixDaysAgo) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
    return `${weekday} ${time}`;
  }

  // Older: include the date. Drop the year for messages in the current year.
  const sameYear = date.getFullYear() === now.getFullYear();
  const datePart = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${datePart} ${time}`;
}

function AttachmentDisplay({ attachments, isUser }: { attachments: AttachmentMeta[]; isUser: boolean }) {
  return (
    <div className="mb-2 flex flex-col gap-2">
      {attachments.map((att, i) => {
        if (att.type === "image") {
          return (
            <a
              key={i}
              href={`/api/attachments/${att.s3Key}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/attachments/${att.s3Key}`}
                alt={att.fileName ?? "Attachment"}
                className="max-h-60 rounded-lg object-contain"
                loading="lazy"
              />
            </a>
          );
        }
        return (
          <a
            key={i}
            href={`/api/attachments/${att.s3Key}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${
              isUser
                ? "border-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/10"
                : "border-border text-foreground hover:bg-accent"
            }`}
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{att.fileName ?? "File"}</span>
            {att.sizeBytes != null && (
              <span className="text-[10px] opacity-60">
                {(att.sizeBytes / 1024).toFixed(0)} KB
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}

export default function ConversationDetailPage() {
  const { t } = useI18n();
  const params = useParams<{ conversationId: string }>();
  const router = useRouter();
  const conversationId = decodeURIComponent(params.conversationId);
  // Every conversation id is `<instanceSlug>:<channelType>:<channelId>` — see
  // packages/engine/src/index.ts. We derive the instance scope from the id
  // itself; the backend rejects requests that don't carry an explicit
  // ?instanceId= (cross-tenant IDOR guard).
  const instanceId = conversationId.split(":")[0] ?? "";

  const [conversation, setConversation] = useState<ConversationListItem | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [debugTarget, setDebugTarget] = useState<DebugSheetTarget | null>(null);
  const [stateOpen, setStateOpen] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);
  const prevScrollHeightRef = useRef<number | null>(null);
  const didInitialScrollRef = useRef(false);

  useEffect(() => {
    Promise.all([
      api.conversations.get(conversationId, instanceId),
      api.conversations.messages(conversationId, instanceId, { limit: MESSAGES_PAGE_SIZE, order: "desc" }),
    ])
      .then(([convRes, msgRes]) => {
        setConversation(convRes.conversation);
        // API returned newest first; reverse to chronological for top-down rendering.
        setMessages([...msgRes.messages].reverse());
        setTotalMessages(msgRes.total);
      })
      .catch(() => {
        toast.error(t("conversations.detail.notFound"));
        router.push("/conversations");
      })
      .finally(() => setLoading(false));
  }, [conversationId, router, t]);

  const handleLoadOlder = async () => {
    if (loadingMoreRef.current) return;
    if (messages.length >= totalMessages) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    prevScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? 0;
    try {
      const result = await api.conversations.messages(conversationId, instanceId, {
        limit: MESSAGES_PAGE_SIZE,
        offset: messages.length,
        order: "desc",
      });
      // Newest-first slice → reverse to chronological, then prepend.
      setMessages((prev) => [...[...result.messages].reverse(), ...prev]);
    } catch {
      toast.error(t("conversations.detail.loadMoreFailed"));
      prevScrollHeightRef.current = null;
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  };

  // After the initial fetch resolves, jump to the bottom (latest message visible).
  // Re-pin on each image load — lazy-loaded images grow the scrollHeight after the
  // first synchronous measure, otherwise the user lands a few hundred px above the bottom.
  useLayoutEffect(() => {
    if (loading) return;
    if (didInitialScrollRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    const imgs = el.querySelectorAll("img");
    const handlers: Array<() => void> = [];
    imgs.forEach((img) => {
      if (img.complete) return;
      const onLoad = () => pin();
      img.addEventListener("load", onLoad, { once: true });
      handlers.push(() => img.removeEventListener("load", onLoad));
    });
    didInitialScrollRef.current = true;
    return () => {
      handlers.forEach((cleanup) => cleanup());
    };
  }, [loading]);

  // After prepending older messages, restore the relative scroll position so the user
  // doesn't get yanked back to the top.
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current == null) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
    prevScrollHeightRef.current = null;
  }, [messages]);

  // Watch the top sentinel: when it scrolls into view, fetch the previous page.
  useEffect(() => {
    if (loading) return;
    if (messages.length >= totalMessages) return;
    const sentinel = topSentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) handleLoadOlder();
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, messages.length, totalMessages]);

  const handleDelete = async () => {
    try {
      await api.conversations.delete(conversationId, instanceId);
      toast.success(t("conversations.detail.deleted"));
      router.push("/conversations");
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("conversations.detail.deleteFailed")));
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("common.loading")}</h1>
      </div>
    );
  }

  if (!conversation) return null;

  const title = conversation.title
    ?? (conversation.summary
      ? conversation.summary.length > 80
        ? conversation.summary.slice(0, 80) + "..."
        : conversation.summary
      : conversationId);

  return (
    <div className="flex h-[calc(100svh-3.5rem-3rem)] flex-col">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/conversations">{t("conversations.detail.breadcrumb")}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{t("conversations.detail.title")}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {conversation.title && conversation.summary && (
            <p className="mt-1 text-sm text-muted-foreground">
              {conversation.summary}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {conversationId}
            </code>
            {conversation.instanceName && (
              <Badge variant="secondary">{conversation.instanceName}</Badge>
            )}
            <span>{t("conversations.detail.messages", { count: conversation.messageCount })}</span>
            <span>&middot;</span>
            <span>{t("conversations.detail.created", { time: formatRelativeTime(conversation.createdAt, t) })}</span>
            {conversation.totalTokens > 0 && (
              <>
                <span>&middot;</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="gap-1 font-normal tabular-nums cursor-help">
                        <Zap className="h-3 w-3" />
                        {conversation.totalTokens.toLocaleString()} tokens
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t("conversations.detail.conversationCost")}: {conversation.conversationTokens.toLocaleString()}</p>
                      <p className="text-muted-foreground">{t("conversations.detail.serviceCost")}: {conversation.serviceTokens.toLocaleString()}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
            {conversation.totalCost > 0 && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="gap-1 font-normal tabular-nums cursor-help">
                      <Coins className="h-3 w-3" />
                      ${conversation.totalCost.toFixed(4)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("conversations.detail.conversationCost")}: ${conversation.conversationCost.toFixed(4)}</p>
                    <p className="text-muted-foreground">{t("conversations.detail.serviceCost")}: ${conversation.serviceCost.toFixed(4)}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => setStateOpen(true)}>
          <Database className="h-4 w-4" />
          {t("conversations.state.button")}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive">
              <Trash2 className="h-4 w-4" />
              {t("conversations.detail.deleteButton")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("conversations.detail.deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("conversations.detail.deleteDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t("common.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="mt-8 flex-1 min-h-0 space-y-4 overflow-y-auto pr-2"
      >
        <div ref={topSentinelRef} aria-hidden="true" />
        {loadingMore && (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        <TooltipProvider>
          {messages.map((msg) => {
            // System message → centered amber pill
            if (msg.role === "system") {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="max-w-[85%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30">
                    <div className="flex items-start gap-2">
                      <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                          {t("conversations.detail.systemMessage")}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm text-amber-800 dark:text-amber-200">
                          {msg.content}
                        </p>
                        {msg.createdAt && (
                          <p className="mt-1 text-xs text-amber-600/60 dark:text-amber-400/60">
                            {formatTime(msg.createdAt)}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            const tokenCount = msg.role === "user" ? msg.promptTokens : msg.completionTokens;
            const costPerToken = conversation.conversationTokens > 0
              ? conversation.conversationCost / conversation.conversationTokens
              : 0;
            const messageCost = tokenCount != null ? tokenCount * costPerToken : 0;

            return (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[75%] min-w-0 overflow-hidden rounded-2xl px-4 py-3 ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  {msg.attachments && msg.attachments.length > 0 && (
                    <AttachmentDisplay attachments={msg.attachments} isUser={msg.role === "user"} />
                  )}
                  {msg.metadata?.originalKind === "audio" && (
                    <span
                      className={`mb-1 inline-flex items-center gap-1 text-xs ${
                        msg.role === "user"
                          ? "text-primary-foreground/60"
                          : "text-muted-foreground"
                      }`}
                      title={(() => {
                        const a = msg.metadata?.audio as
                          | { durationSec?: number; sttProvider?: string; language?: string }
                          | undefined;
                        const parts: string[] = [];
                        if (typeof a?.durationSec === "number") parts.push(`${a.durationSec.toFixed(1)}s`);
                        if (a?.sttProvider) parts.push(a.sttProvider);
                        if (a?.language) parts.push(a.language);
                        return parts.length ? `Audio · ${parts.join(" · ")}` : "Audio";
                      })()}
                      aria-label="Messaggio originato da audio"
                    >
                      <Mic className="h-3 w-3" />
                    </span>
                  )}
                  {/* Reasoning + steps panels above message text. Default open
                      on the conversations page (audit/exploratory UX). */}
                  {msg.role !== "user" && (
                    <MessageExtras
                      reasoning={msg.reasoning}
                      steps={msg.steps}
                      defaultOpen
                    />
                  )}
                  <MarkdownRenderer content={msg.content} />
                  <div
                    className={`mt-1 flex items-center gap-1.5 text-xs ${
                      msg.role === "user"
                        ? "text-primary-foreground/60"
                        : "text-muted-foreground"
                    }`}
                  >
                    <span>{formatTime(msg.createdAt)}</span>
                    {tokenCount != null && tokenCount > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex cursor-default items-center">
                            <Info className="h-3 w-3" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="space-y-0.5">
                          <p className="flex items-center gap-1 tabular-nums">
                            <Zap className="h-3 w-3" />
                            {msg.role === "user"
                              ? t("conversations.detail.inputTokens", { count: tokenCount.toLocaleString() })
                              : t("conversations.detail.outputTokens", { count: tokenCount.toLocaleString() })}
                          </p>
                          {messageCost > 0 && (
                            <p className="flex items-center gap-1 tabular-nums">
                              <Coins className="h-3 w-3" />
                              ${messageCost.toFixed(4)}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {msg.role !== "user" && (
                      <button
                        type="button"
                        onClick={() =>
                          setDebugTarget({ conversationId, messageId: msg.id, instanceId })
                        }
                        className="inline-flex items-center gap-1 rounded px-1 text-muted-foreground transition hover:text-foreground"
                        title={t("message.debug.open")}
                      >
                        <SearchCode className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </TooltipProvider>

        {messages.length === 0 && (
          <p className="text-center text-muted-foreground">
            {t("conversations.detail.noMessages")}
          </p>
        )}
      </div>

      <DebugSheet
        open={debugTarget !== null}
        onOpenChange={(o) => !o && setDebugTarget(null)}
        target={debugTarget}
      />
      <ContextStoreSheet
        open={stateOpen}
        onOpenChange={setStateOpen}
        conversationId={conversationId}
        instanceId={instanceId}
      />
    </div>
  );
}
