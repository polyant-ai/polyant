// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Trash2, Loader2, FileText, Mic, SearchCode, Database, Webhook, Link2, Pencil, ArrowLeft, Copy, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, getUserErrorMessage, type ConversationListItem, type ConversationMessage, type AttachmentMeta, type HookExecution } from "@/lib/api";
import { MarkdownRenderer } from "@/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/playground/_components/markdown-renderer";
import { MessageExtras } from "@/components/messages/message-extras";
import { MessageMetadataPills } from "@/components/messages/message-metadata-pills";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ChannelIcon } from "@/components/channel-icon";
import { HookExecutionPill } from "@/components/messages/hook-execution-pill";
import { SystemActivity } from "@/components/messages/system-activity";
import { DebugSheet, type DebugSheetTarget } from "@/components/messages/debug-sheet";
import { ContextStoreSheet } from "@/components/messages/context-store-sheet";
import { formatActivityTimestamp, formatRelativeTime, parseUTC } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";
import { useFormat } from "@/lib/use-format";
import { useDetailedView } from "@/hooks/use-detailed-view";
import { currentTurn, useLiveConversation } from "@/hooks/use-live-conversation";
import { useFollowBottom } from "@/hooks/use-follow-bottom";
import { LiveTurn } from "@/components/messages/live-turn";

const MESSAGES_PAGE_SIZE = 50;

/** A stored message's time in ms; 0 when the row carries none. */
function storedAt(message: ConversationMessage): number {
  return message.createdAt ? parseUTC(message.createdAt).getTime() : 0;
}

/**
 * The proxy URL for a stored attachment.
 *
 * Each key SEGMENT is percent-encoded, never the key as a whole — the slashes
 * are the route's structure and must survive. Interpolating the raw key made a
 * filename carrying `#` unreachable (everything after it became the fragment
 * and never left the browser) and one carrying `?` land as a query string. The
 * `fileUpload` tool already builds its display URL exactly this way; this is the
 * same rule on the reading side.
 */
function attachmentHref(s3Key: string): string {
  return `/api/attachments/${s3Key.split("/").map(encodeURIComponent).join("/")}`;
}

function AttachmentDisplay({ attachments, isUser }: { attachments: AttachmentMeta[]; isUser: boolean }) {
  return (
    <div className="mb-2 flex flex-col gap-2">
      {attachments.map((att, i) => {
        if (att.type === "image") {
          return (
            <a
              key={i}
              href={attachmentHref(att.s3Key)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachmentHref(att.s3Key)}
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
            href={attachmentHref(att.s3Key)}
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
  const { t, locale } = useI18n();
  const fmt = useFormat();
  const params = useParams<{ conversationId: string }>();
  const router = useRouter();
  const paths = useTenantPaths();
  const conversationId = decodeURIComponent(params.conversationId);
  // Every conversation id is `<instanceSlug>:<channelType>:<channelId>` — see
  // packages/engine/src/index.ts. We derive the instance scope from the id
  // itself; the backend rejects requests that don't carry an explicit
  // ?instanceId= (cross-tenant IDOR guard).
  const instanceId = conversationId.split(":")[0] ?? "";

  const [conversation, setConversation] = useState<ConversationListItem | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [hookExecutions, setHookExecutions] = useState<HookExecution[]>([]);
  const [debugTarget, setDebugTarget] = useState<DebugSheetTarget | null>(null);
  const [stateOpen, setStateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameId, setRenameId] = useState("");
  const [renaming, setRenaming] = useState(false);
  // Controlled: the delete confirmation opens from the actions menu, not from its own button.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Detailed view: shows per-message metadata pills + reasoning/tool panels.
  // Off by default; the choice is shared with the Playground and persists.
  const [detailed, toggleDetailed] = useDetailedView();
  // Live: follow the conversation as it happens, on whatever channel it runs.
  const [live, setLive] = useState(false);
  // Message targeted by a shared deep link (#msg-<id>) — briefly ring-highlighted.
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);
  const prevScrollHeightRef = useRef<number | null>(null);
  const didInitialScrollRef = useRef(false);

  // Copy a deep link to a specific message. Opening it scrolls to and
  // highlights that message (see the deep-link effect below).
  const handleShare = async (messageId: string) => {
    const url = `${window.location.origin}${window.location.pathname}#msg-${messageId}`;
    try {
      await navigator.clipboard.writeText(url);
      window.history.replaceState(null, "", `#msg-${messageId}`);
      toast.success(t("conversations.detail.linkCopied"));
      // Flash the message so the user sees which one they just linked.
      setHighlightId(messageId);
      setTimeout(() => setHighlightId((cur) => (cur === messageId ? null : cur)), 2600);
    } catch {
      toast.error(t("conversations.detail.linkCopyFailed"));
    }
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(conversationId);
      toast.success(t("conversations.detail.idCopied"));
    } catch {
      toast.error(t("conversations.detail.idCopyFailed"));
    }
  };

  useEffect(() => {
    Promise.all([
      api.conversations.get(conversationId, instanceId),
      api.conversations.messages(conversationId, instanceId, { limit: MESSAGES_PAGE_SIZE, order: "desc" }),
      // Hook telemetry is decorative — a failed fetch never blocks the page.
      api.conversations.hookExecutions(conversationId, instanceId).catch(() => ({ executions: [] as HookExecution[] })),
    ])
      .then(([convRes, msgRes, hooksRes]) => {
        setConversation(convRes.conversation);
        // API returned newest first; reverse to chronological for top-down rendering.
        setMessages([...msgRes.messages].reverse());
        setTotalMessages(msgRes.total);
        setHookExecutions(hooksRes.executions);
      })
      .catch(() => {
        toast.error(t("conversations.detail.notFound"));
        router.push(paths.workspace("/conversations"));
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

  // Re-read the header, the newest page and hooks after the engine stores rows.
  // Merged by id, so older pages already loaded stay and a re-read row is replaced.
  const refreshLatest = useCallback(async () => {
    try {
      const [convRes, msgRes, hooksRes] = await Promise.all([
        api.conversations.get(conversationId, instanceId).catch(() => null),
        api.conversations.messages(conversationId, instanceId, { limit: MESSAGES_PAGE_SIZE, order: "desc" }),
        api.conversations.hookExecutions(conversationId, instanceId).catch(() => null),
      ]);
      if (convRes) setConversation(convRes.conversation);
      setMessages((prev) => {
        const byId = new Map(prev.map((m) => [m.id, m]));
        for (const m of msgRes.messages) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => storedAt(a) - storedAt(b));
      });
      setTotalMessages(msgRes.total);
      if (hooksRes) setHookExecutions(hooksRes.executions);
    } catch {
      // The next stored write retries; the transcript on screen stays valid.
    }
  }, [conversationId, instanceId]);

  const { events: liveEvents, connected: liveConnected } = useLiveConversation({
    conversationId,
    instanceId,
    enabled: live && !loading,
    onPersisted: refreshLatest,
  });

  // The turn in progress. Once its rows are stored they take its place in the
  // transcript.
  const pendingLive = useMemo(
    () => currentTurn(
      liveEvents,
      messages.filter((m) => m.role === "user").map(storedAt),
      Math.max(0, ...messages.map(storedAt)),
    ),
    [liveEvents, messages],
  );

  // Keep the newest activity in view while following, unless the reader has
  // scrolled up to read something older.
  const liveContent = useMemo(() => [pendingLive, messages], [pendingLive, messages]);
  useFollowBottom(scrollContainerRef, live, liveContent);

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

  // Deep link (#msg-<id>): once messages are loaded, scroll to the targeted
  // message and briefly highlight it. Only works if the message is in the
  // loaded window (older messages beyond the first pages aren't fetched yet).
  useEffect(() => {
    if (loading) return;
    const match = window.location.hash.match(/^#msg-(.+)$/);
    if (!match) return;
    const el = document.getElementById(`msg-${match[1]}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightId(match[1]);
    const timer = setTimeout(() => setHighlightId(null), 2600);
    return () => clearTimeout(timer);
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

  // Merge messages and hook executions into a single chronological timeline.
  // Executions older than the loaded message window are hidden so pagination
  // doesn't pile them all at the top.
  type TimelineItem =
    | { kind: "message"; msg: ConversationMessage; ts: number }
    | { kind: "hook"; exec: HookExecution; ts: number };

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = messages.map((msg) => ({
      kind: "message" as const,
      msg,
      ts: msg.createdAt ? parseUTC(msg.createdAt).getTime() : 0,
    }));
    const loadedTs = items.map((i) => i.ts).filter((ts) => ts > 0);
    const oldestLoaded = loadedTs.length > 0 ? Math.min(...loadedTs) : 0;
    const hasOlderPages = messages.length < totalMessages;
    for (const exec of hookExecutions) {
      const ts = parseUTC(exec.createdAt).getTime();
      if (hasOlderPages && ts < oldestLoaded) continue;
      items.push({ kind: "hook" as const, exec, ts });
    }
    return items.sort((a, b) => a.ts - b.ts);
  }, [messages, hookExecutions, totalMessages]);

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

  const openRename = () => {
    setRenameTitle(conversation?.title ?? "");
    setRenameId(conversationId);
    setRenameOpen(true);
  };

  const handleRename = async () => {
    const nextId = renameId.trim();
    const nextTitle = renameTitle.trim();
    if (!nextTitle) {
      toast.error(t("conversations.detail.renameTitleRequired"));
      return;
    }
    if (!nextId) {
      toast.error(t("conversations.detail.renameIdRequired"));
      return;
    }
    setRenaming(true);
    try {
      await api.conversations.rename(conversationId, instanceId, {
        conversationId: nextId,
        title: nextTitle,
      });
      toast.success(t("conversations.detail.renamed"));
      setRenameOpen(false);
      if (nextId !== conversationId) {
        // The id changed → the current route is stale; navigate to the new one.
        router.push(paths.workspace(`/conversations/${encodeURIComponent(nextId)}`));
      } else {
        setConversation((c) => (c ? { ...c, title: nextTitle } : c));
      }
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("conversations.detail.renameFailed")));
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    try {
      await api.conversations.delete(conversationId, instanceId);
      toast.success(t("conversations.detail.deleted"));
      router.push(paths.workspace("/conversations"));
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
      <Link
        href={paths.workspace("/conversations")}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("conversations.detail.breadcrumb")}
      </Link>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {live && (
              <span
                role="status"
                title={t(liveConnected ? "conversations.detail.liveConnected" : "conversations.detail.liveConnecting")}
                className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${liveConnected ? "text-success" : "text-muted-foreground"}`}
              >
                <span className={`size-2 rounded-full ${liveConnected ? "animate-pulse bg-success" : "bg-muted-foreground"}`} />
                {t("conversations.detail.liveToggle")}
              </span>
            )}
          </div>
          {conversation.title && conversation.summary && (
            <p className="mt-1 text-sm text-muted-foreground">
              {conversation.summary}
            </p>
          )}
          <TooltipProvider>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {[
                conversation.channel && (
                  <span key="channel" className="inline-flex items-center gap-1.5 capitalize text-foreground">
                    <ChannelIcon channel={conversation.channel} className="size-3.5" />
                    {conversation.channel}
                  </span>
                ),
                conversation.instanceName && <span key="agent">{conversation.instanceName}</span>,
                <span key="messages">{t("conversations.detail.messages", { count: conversation.messageCount })}</span>,
                <span key="created">{t("conversations.detail.created", { time: formatRelativeTime(conversation.createdAt, t) })}</span>,
                conversation.totalTokens > 0 && (
                  <Tooltip key="tokens">
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="cursor-help tabular-nums underline decoration-dotted underline-offset-4">
                        {t("conversations.detail.totalTokens", { count: fmt.number(conversation.totalTokens) })}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t("conversations.detail.conversationCost")}: {fmt.number(conversation.conversationTokens)}</p>
                      <p className="text-muted-foreground">{t("conversations.detail.serviceCost")}: {fmt.number(conversation.serviceTokens)}</p>
                      {conversation.cachedInputTokens + conversation.cacheCreationInputTokens > 0 && (
                        <p className="text-muted-foreground">
                          {t("conversations.detail.cacheTokens")}: {fmt.number(conversation.cachedInputTokens)} / {fmt.number(conversation.cacheCreationInputTokens)}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                ),
                conversation.totalCost > 0 && (
                  <Tooltip key="cost">
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="cursor-help tabular-nums underline decoration-dotted underline-offset-4">
                        ${conversation.totalCost.toFixed(4)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t("conversations.detail.conversationCost")}: ${conversation.conversationCost.toFixed(4)}</p>
                      <p className="text-muted-foreground">{t("conversations.detail.serviceCost")}: ${conversation.serviceCost.toFixed(4)}</p>
                    </TooltipContent>
                  </Tooltip>
                ),
              ]
                .filter(Boolean)
                .flatMap((item, i) => (i === 0 ? [item] : [<span key={`sep-${i}`} aria-hidden="true">&middot;</span>, item]))}
            </div>
          </TooltipProvider>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setStateOpen(true)}>
            <Database className="h-4 w-4" />
            {t("conversations.state.button")}
          </Button>
          {/* Non-modal so the rename/delete dialogs it opens get focus and pointer events back. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label={t("conversations.detail.moreActions")}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {/* View toggles keep the menu open (preventDefault) so both can be flipped in one go. */}
              <DropdownMenuItem
                role="menuitemcheckbox"
                aria-checked={detailed}
                onSelect={(e) => {
                  e.preventDefault();
                  toggleDetailed(!detailed);
                }}
              >
                {t("conversations.detail.detailedToggle")}
                <Switch checked={detailed} tabIndex={-1} aria-hidden="true" className="pointer-events-none ml-auto" />
              </DropdownMenuItem>
              <DropdownMenuItem
                role="menuitemcheckbox"
                aria-checked={live}
                onSelect={(e) => {
                  e.preventDefault();
                  setLive((v) => !v);
                }}
              >
                {t("conversations.detail.liveToggle")}
                <Switch checked={live} tabIndex={-1} aria-hidden="true" className="pointer-events-none ml-auto" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleCopyId}>
                <Copy />
                {t("conversations.detail.copyId")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openRename}>
                <Pencil />
                {t("conversations.detail.renameButton")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                {t("conversations.detail.deleteButton")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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

      <div
        ref={scrollContainerRef}
        className="mt-6 flex-1 min-h-0 space-y-4 overflow-y-auto pr-2"
      >
        <div ref={topSentinelRef} aria-hidden="true" />
        {loadingMore && (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        <TooltipProvider>
          {timeline.map((item) => {
            if (item.kind === "hook") {
              const exec = item.exec;
              return detailed ? (
                <div key={`hook-${exec.id}`} className="max-w-[85%]">
                  <HookExecutionPill execution={exec} timestamp={formatActivityTimestamp(exec.createdAt, locale)} />
                </div>
              ) : null;
            }

            const msg = item.msg;
            if (msg.role === "system") {
              return detailed ? (
                <div key={msg.id} className="max-w-[85%]">
                  <SystemActivity content={msg.content} timestamp={msg.createdAt ? formatActivityTimestamp(msg.createdAt, locale) : undefined} />
                </div>
              ) : null;
            }

            return (
              <div
                key={msg.id}
                id={`msg-${msg.id}`}
                className={`flex scroll-mt-4 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div className={`${msg.role === "user" ? "max-w-[75%]" : "max-w-[85%]"} min-w-0`}>
                  {msg.role !== "user" && detailed && (
                    <MessageExtras reasoning={msg.reasoning} steps={msg.steps} />
                  )}
                <div
                  className={`min-w-0 overflow-hidden rounded-2xl px-4 py-3 transition-colors duration-500 ${
                    highlightId === msg.id
                      ? "bg-accent text-accent-foreground ring-2 ring-accent-strong"
                      : msg.role === "user"
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
                  {msg.role !== "user" && detailed && msg.metadata?.source === "hook" && (
                    <span className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Webhook className="h-3 w-3" />
                      {t("message.provenance.hook", { name: String(msg.metadata.hookName ?? "") })}
                    </span>
                  )}
                  <MarkdownRenderer content={msg.content} />
                  {msg.role !== "user" && detailed && (
                    <MessageMetadataPills message={msg} />
                  )}
                  <div
                    className={`mt-1 flex items-center gap-1.5 text-xs ${
                      msg.role === "user"
                        ? "text-primary-foreground/60"
                        : "text-muted-foreground"
                    }`}
                  >
                    <span>{formatActivityTimestamp(msg.createdAt, locale)}</span>
                    <button
                      type="button"
                      onClick={() => handleShare(msg.id)}
                      className="inline-flex items-center rounded px-1 opacity-70 transition hover:opacity-100"
                      title={t("conversations.detail.share")}
                    >
                      <Link2 className="h-3 w-3" />
                    </button>
                    {msg.role !== "user" && (
                      <button
                        type="button"
                        onClick={() =>
                          setDebugTarget({
                            conversationId,
                            messageId: msg.id,
                            instanceId,
                            model: msg.model,
                            provider: msg.provider,
                            promptTokens: msg.promptTokens,
                            completionTokens: msg.completionTokens,
                            cachedInputTokens: msg.cachedInputTokens,
                            cacheCreationInputTokens: msg.cacheCreationInputTokens,
                            cost: msg.cost,
                            thinking: msg.thinking,
                            temperature: msg.temperature,
                            latency: msg.latency,
                          })
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
              </div>
            );
          })}
        </TooltipProvider>

        <LiveTurn events={pendingLive} showActivity={detailed} />

        {messages.length === 0 && pendingLive.length === 0 && (
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

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("conversations.detail.renameTitle")}</DialogTitle>
            <DialogDescription>
              {t("conversations.detail.renameDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="rename-title">{t("conversations.detail.renameTitleLabel")}</Label>
              <Input
                id="rename-title"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rename-id">{t("conversations.detail.renameIdLabel")}</Label>
              <Input
                id="rename-id"
                value={renameId}
                onChange={(e) => setRenameId(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t("conversations.detail.renameIdHint")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)} disabled={renaming}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleRename} disabled={renaming}>
              {renaming && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
