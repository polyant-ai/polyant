// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState, useCallback } from "react";
import { usePagination } from "@/hooks/use-pagination";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Database } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { ListBadgeCell, ListHead, ListMetaCell, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { LoadFailed } from "@/components/ui/load-failed";
import { Pager } from "@/components/ui/pager";
import {
  api,
  getUserErrorMessage,
  type Instance,
  type ConversationListItem,
  type ConversationSearchResult,
} from "@/lib/api";
import { ChannelIcon } from "@/components/channel-icon";
import { useI18n } from "@/lib/i18n/context";
import { truncate } from "@/lib/format";
import { FROM_AGENT_PARAM, FROM_AGENT_VALUE } from "@/lib/conversations/from-agent";
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";
import { useWorkspaceSlug } from "@/lib/tenant/use-workspace-slug";
import { useFormat } from "@/lib/use-format";

function isSearchResult(
  c: ConversationListItem,
): c is ConversationSearchResult {
  return "matchCount" in c;
}

/**
 * The conversations table — ONE implementation, two places.
 *
 * The workspace page renders it with the agent filter; the agent's own Attività
 * section renders it with `lockedInstanceId`, which fixes the agent, drops the
 * filter (it has already been answered) and drops the Agente column (it would
 * repeat the same name down every row).
 *
 * Extracted rather than rewritten: a second list would have to re-earn the search,
 * the pagination, the cached-token pill and the search-snippet rendering, and
 * would drift from this one the first time either changed.
 *
 * A conversation is a destination with a page of its own, so a row goes there
 * instead of opening a drawer. Search is the engine's (it reads the messages, not
 * the page of rows on screen), so the box is not filtered here; rows are in the
 * engine's order, most recent activity first.
 */
export function ConversationsView({ lockedInstanceId }: { lockedInstanceId?: string }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const paths = useTenantPaths();
  const workspaceSlug = useWorkspaceSlug();
  const PAGE_SIZE = 20;
  const { page, setPage, search, setSearch, debouncedSearch, totalPages, setTotal, offset } = usePagination({ pageSize: PAGE_SIZE });
  const [conversations, setConversations] = useState<ConversationListItem[]>(
    [],
  );
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [instanceFilter, setInstanceFilter] = useState(lockedInstanceId ?? "");
  // A direct link may narrow to one contact (`?contact=`); there is no field for it,
  // because the search box already matches the contact.
  const contact = useSearchParams().get("contact")?.trim() ?? "";

  // Fetch instances for filter dropdown — re-fetch when workspace changes.
  // Also reset the stale instance filter so the user doesn't see an empty list.
  // Skipped entirely when the agent is fixed: there is no dropdown to fill, and
  // resetting the filter would unfix it.
  useEffect(() => {
    if (lockedInstanceId) return;
    setInstanceFilter("");
    setPage(1);
    api.instances.list().then(({ instances }) => setInstances(instances)).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, lockedInstanceId]);

  // Fetch conversations
  const fetchConversations = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const result = await api.conversations.list({
        instanceId: instanceFilter || undefined,
        search: debouncedSearch || undefined,
        userIdentifier: contact || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setConversations(result.conversations);
      setTotal(result.total);
    } catch (err) {
      setFailed(true);
      toast.error(getUserErrorMessage(err, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [instanceFilter, debouncedSearch, contact, offset, setTotal, t]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  return (
    <div>
      <ListToolbar value={search} onChange={setSearch} label={t("conversations.searchPlaceholder")}>
        {!lockedInstanceId && (
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
        )}
      </ListToolbar>

      <div>
        {failed ? (
          <LoadFailed onRetry={fetchConversations} />
        ) : loading ? (
          <ListLoading className="mt-4" />
        ) : conversations.length === 0 ? (
          debouncedSearch || contact ? (
            <ListNoResults>{t("conversations.empty.searchTitle")}</ListNoResults>
          ) : (
            <ListEmpty className={lockedInstanceId ? "mt-8" : "mt-16"} title={t("conversations.empty.title")} description={t("conversations.empty.description")} />
          )
        ) : (
          <>
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ListHead className="w-[27%]">{t("conversations.table.conversation")}</ListHead>
                  {!lockedInstanceId && (
                    <ListHead className="hidden md:table-cell w-[13%]">{t("conversations.table.instance")}</ListHead>
                  )}
                  <ListHead className="hidden md:table-cell w-[14%]">{t("conversations.column.userIdentifier")}</ListHead>
                  <ListHead className="w-[6%] text-center">{t("conversations.table.channel")}</ListHead>
                  <ListHead className="hidden md:table-cell w-[7%]">{t("conversations.table.messages")}</ListHead>
                  <ListHead className="hidden md:table-cell w-[12%]">{t("conversations.table.tokens")}</ListHead>
                  <ListHead className="hidden md:table-cell w-[11%]">{t("conversations.table.cost")}</ListHead>
                  <ListHead align="end" className="w-[11%]">{t("conversations.table.lastActivity")}</ListHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversations.map((conv) => {
                  const href = paths.workspace(
                    `/conversations/${encodeURIComponent(conv.conversationId)}${
                      lockedInstanceId
                        ? `?instanceId=${encodeURIComponent(lockedInstanceId)}&${FROM_AGENT_PARAM}=${FROM_AGENT_VALUE}`
                        : ""
                    }`,
                  );
                  return (
                    <ListRow key={conv.id} href={href}>
                      <ListNameCell
                        name={conv.title ? conv.title : conv.summary ? truncate(conv.summary, 60) : t("conversations.newChat")}
                        href={href}
                        summary={summaryOf(conv)}
                      />
                      {!lockedInstanceId && (
                        conv.instanceName ? (
                          <ListBadgeCell className="hidden md:table-cell">{conv.instanceName}</ListBadgeCell>
                        ) : (
                          <ListMetaCell className="hidden md:table-cell">&mdash;</ListMetaCell>
                        )
                      )}
                      <TableCell className="hidden md:table-cell max-w-0">
                        {conv.userIdentifier ? (
                          <span className="block truncate" title={conv.userIdentifier}>
                            {conv.userIdentifier}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">&mdash;</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {conv.channel ? (
                          <span
                            title={conv.channel}
                            aria-label={conv.channel}
                            className="inline-flex text-muted-foreground"
                          >
                            <ChannelIcon channel={conv.channel} />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">&mdash;</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {conv.messageCount}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {fmt.number(conv.conversationTokens)}
                        {conv.serviceTokens > 0 && (
                          <span className="text-xs text-muted-foreground/60 ml-1">
                            (+{fmt.number(conv.serviceTokens)})
                          </span>
                        )}
                        {conv.cachedInputTokens + conv.cacheCreationInputTokens > 0 && (
                          <span
                            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground/60 ml-1 tabular-nums"
                            title={`${t("conversations.list.cachedTokens")} — ${t("conversations.detail.pills.cacheRead")}: ${fmt.number(conv.cachedInputTokens)}, ${t("conversations.detail.pills.cacheWrite")}: ${fmt.number(conv.cacheCreationInputTokens)}`}
                          >
                            <Database className="h-3 w-3" />
                            {fmt.number(conv.cachedInputTokens + conv.cacheCreationInputTokens)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {fmt.currency(conv.conversationCost)}
                        {conv.serviceCost > 0 && (
                          <span className="text-xs text-muted-foreground/60 ml-1">
                            (+{fmt.currency(conv.serviceCost)})
                          </span>
                        )}
                      </TableCell>
                      <ListMetaCell align="end">{fmt.relative(conv.updatedAt)}</ListMetaCell>
                    </ListRow>
                  );
                })}
              </TableBody>
            </ListTable>

            <Pager page={page} totalPages={totalPages} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );

  /** The line under the title: the matching snippet of a search hit, else the summary. */
  function summaryOf(conv: ConversationListItem) {
    if (isSearchResult(conv)) {
      return conv.bestSnippet ? (
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
      );
    }
    return conv.title && conv.summary ? truncate(conv.summary, 100) : undefined;
  }
}
