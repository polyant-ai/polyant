// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState, useCallback } from "react";
import { usePagination } from "@/hooks/use-pagination";
import Link from "next/link";
import { toast } from "sonner";
import { MessageSquare, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  getUserErrorMessage,
  type Instance,
  type ConversationListItem,
  type ConversationSearchResult,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { formatRelativeTime, truncate } from "@/lib/format";

function isSearchResult(
  c: ConversationListItem,
): c is ConversationSearchResult {
  return "matchCount" in c;
}

export default function ConversationsPage() {
  const { t } = useI18n();
  const PAGE_SIZE = 20;
  const { page, setPage, search, setSearch, debouncedSearch, totalPages, setTotal, offset } = usePagination({ pageSize: PAGE_SIZE });
  const [conversations, setConversations] = useState<ConversationListItem[]>(
    [],
  );
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [instanceFilter, setInstanceFilter] = useState("");

  // Fetch instances for filter dropdown
  useEffect(() => {
    api.instances.list().then(({ instances }) => setInstances(instances)).catch(() => {});
  }, []);

  // Fetch conversations
  const fetchConversations = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.conversations.list({
        instanceId: instanceFilter || undefined,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setConversations(result.conversations);
      setTotal(result.total);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [page, instanceFilter, debouncedSearch, offset, setTotal]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  return (
    <div>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("conversations.title")}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t("conversations.subtitle")}
        </p>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select
          value={instanceFilter || "_all"}
          onValueChange={(v) => {
            setInstanceFilter(v === "_all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t("conversations.allInstances")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t("conversations.allInstances")}</SelectItem>
            {instances.map((inst) => (
              <SelectItem key={inst.id} value={inst.slug}>
                {inst.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t("conversations.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div className="mt-6">
        {loading ? (
          <div>
            <p className="text-muted-foreground">{t("common.loading")}</p>
          </div>
        ) : conversations.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="rounded-full bg-muted p-4">
              <MessageSquare className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">
              {debouncedSearch
                ? t("conversations.empty.searchTitle")
                : t("conversations.empty.title")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {debouncedSearch
                ? t("conversations.empty.searchDescription")
                : t("conversations.empty.description")}
            </p>
          </div>
        ) : (
          <>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">{t("conversations.table.conversation")}</TableHead>
                  <TableHead className="hidden md:table-cell w-[15%]">
                    {t("conversations.table.instance")}
                  </TableHead>
                  <TableHead className="hidden md:table-cell w-[8%]">
                    {t("conversations.table.messages")}
                  </TableHead>
                  <TableHead className="hidden md:table-cell w-[13%]">
                    {t("conversations.table.tokens")}
                  </TableHead>
                  <TableHead className="hidden md:table-cell w-[13%]">
                    {t("conversations.table.cost")}
                  </TableHead>
                  <TableHead className="text-right w-[11%]">
                    {t("conversations.table.lastActivity")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversations.map((conv) => (
                  <TableRow key={conv.id} className="cursor-pointer">
                    <TableCell className="font-medium max-w-0 truncate">
                      <Link
                        href={`/conversations/${encodeURIComponent(conv.conversationId)}`}
                        className="hover:underline"
                      >
                        {conv.title
                          ? conv.title
                          : conv.summary
                            ? truncate(conv.summary, 60)
                            : t("conversations.newChat")}
                      </Link>
                      {isSearchResult(conv) && (
                        <p className="mt-0.5 text-xs font-normal text-muted-foreground line-clamp-1">
                          {conv.bestSnippet ? (
                            <>
                              {conv.bestSnippet}
                              <span className="ml-2">
                                {conv.matchCount === 1
                                  ? t("conversations.match", { count: conv.matchCount })
                                  : t("conversations.matches", { count: conv.matchCount })}
                              </span>
                            </>
                          ) : (
                            conv.conversationId
                          )}
                        </p>
                      )}
                      {!isSearchResult(conv) && conv.title && conv.summary && (
                        <p className="mt-0.5 text-xs font-normal text-muted-foreground line-clamp-1">
                          {truncate(conv.summary, 100)}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {conv.instanceName ? (
                        <Badge variant="secondary">{conv.instanceName}</Badge>
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {conv.messageCount}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {conv.conversationTokens.toLocaleString()}
                      {conv.serviceTokens > 0 && (
                        <span className="text-xs text-muted-foreground/60 ml-1">
                          (+{conv.serviceTokens.toLocaleString()})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      ${conv.conversationCost.toFixed(4)}
                      {conv.serviceCost > 0 && (
                        <span className="text-xs text-muted-foreground/60 ml-1">
                          (+${conv.serviceCost.toFixed(4)})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatRelativeTime(conv.updatedAt, t)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t("conversations.previous")}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("conversations.next")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
