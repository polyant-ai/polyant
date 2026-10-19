// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Fragment, useEffect, useState } from "react";
import { usePagination } from "@/hooks/use-pagination";
import { toast } from "sonner";
import { ScrollText, Search, AlertCircle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
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
  isForbidden,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { PageHeader } from "@/components/layout/page-header";
import { Pager } from "@/components/ui/pager";
import { useResource } from "@/hooks/use-resource";
import { PermissionRequired } from "@/components/layout/permission-required";
import { truncate } from "@/lib/format";
import { useFormat } from "@/lib/use-format";

const PAGE_SIZE = 30;

export default function AuditLogsPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const {
    page,
    setPage,
    search,
    setSearch,
    debouncedSearch,
    offset,
  } = usePagination({ pageSize: PAGE_SIZE });

  const [instanceFilter, setInstanceFilter] = useState("");
  const [toolFilter, setToolFilter] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // Agents for the filter dropdown.
  const { data: instancesData, error: instancesError } = useResource("instances", () => api.instances.list());
  const instances = instancesData?.instances ?? [];

  // Stats — `instanceId` is optional: when the dropdown is on "all agents" we
  // send `undefined` and the backend returns system-wide stats.
  const { data: stats, error: statsError } = useResource(["audit-stats", instanceFilter], () =>
    api.auditLogs.stats({ instanceId: instanceFilter || undefined }),
  );

  // Audit logs — same: `undefined` instanceId means "show every instance".
  const { data: logsData, error: logsError, loading } = useResource(
    ["audit-logs", instanceFilter, toolFilter, debouncedSearch, offset],
    () =>
      api.auditLogs.list({
        instanceId: instanceFilter || undefined,
        toolName: toolFilter || undefined,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  );
  const logs = logsData?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((logsData?.total ?? 0) / PAGE_SIZE));

  // `audit_log:read` is admin+. The nav entry is offered to every role because
  // the panel cannot know the caller's, so a viewer legitimately lands here and
  // both audit fetches refuse. That is an ANSWER, not a failure — it replaces the
  // page body rather than raising the "failed to load" toast it used to.
  const forbidden = isForbidden(statsError) || isForbidden(logsError);

  // Anything else that failed is said once, when it arrives.
  const failure = [instancesError, statsError, logsError].find((err) => err !== undefined && !isForbidden(err));
  useEffect(() => {
    if (failure !== undefined) toast.error(getUserErrorMessage(failure, t("common.loadFailed")));
    // `t` is stable per locale; the failure itself is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure]);

  // Unique tool names from stats for filter dropdown
  const toolNames = stats?.byTool.map((t) => t.toolName) ?? [];

  // Early, before the filters: with no readable log there is nothing to filter,
  // and a working search over a permanently empty table is the misleading half
  // of the dead-end this replaces.
  const header = <PageHeader title={t("auditLog.title")} subtitle={t("auditLog.subtitle")} />;

  if (forbidden) {
    return (
      <div>
        {header}
        <PermissionRequired description={t("permission.required.auditLogs")} />
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* Stats cards */}
      {stats && (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground">
                {t("auditLog.stats.totalEntries")}
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {stats.totalEntries.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground">
                {t("auditLog.stats.errorCount")}
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {stats.errorCount.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground">
                {t("auditLog.stats.errorRate")}
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {(stats.errorRate * 100).toFixed(1)}%
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select
          value={instanceFilter || "_all"}
          onValueChange={(v) => {
            setInstanceFilter(v === "_all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t("auditLog.allInstances")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">
              {t("auditLog.allInstances")}
            </SelectItem>
            {instances.map((inst) => (
              <SelectItem key={inst.id} value={inst.slug}>
                {inst.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={toolFilter || "_all"}
          onValueChange={(v) => {
            setToolFilter(v === "_all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t("auditLog.allTools")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t("auditLog.allTools")}</SelectItem>
            {toolNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t("auditLog.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Table */}
      <div className="mt-6">
        {loading ? (
          <div>
            <p className="text-muted-foreground">{t("common.loading")}</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="rounded-full bg-muted p-4">
              <ScrollText className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">
              {debouncedSearch || toolFilter
                ? t("auditLog.empty.searchTitle")
                : t("auditLog.empty.title")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {debouncedSearch || toolFilter
                ? t("auditLog.empty.searchDescription")
                : t("auditLog.empty.description")}
            </p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px]">
                    {t("auditLog.table.timestamp")}
                  </TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t("auditLog.table.instance")}
                  </TableHead>
                  <TableHead>{t("auditLog.table.tool")}</TableHead>
                  <TableHead>{t("auditLog.table.action")}</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {t("auditLog.table.details")}
                  </TableHead>
                  <TableHead className="hidden md:table-cell w-[80px]">
                    {t("auditLog.table.duration")}
                  </TableHead>
                  <TableHead className="w-[70px]">
                    {t("auditLog.table.status")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <Fragment key={log.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() =>
                        setExpandedRow(
                          expandedRow === log.id ? null : log.id,
                        )
                      }
                    >
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {fmt.dateTime(log.createdAt)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="secondary">{log.instanceId}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {log.toolName}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{log.action}</Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-muted-foreground max-w-[300px] truncate">
                        {truncate(formatDetails(log.details), 60)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {log.durationMs != null
                          ? `${log.durationMs}ms`
                          : "\u2014"}
                      </TableCell>
                      <TableCell>
                        {log.success ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-destructive" />
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedRow === log.id && (
                      <TableRow key={`${log.id}-details`}>
                        <TableCell
                          colSpan={7}
                          className="bg-muted/50 p-4"
                        >
                          <div className="space-y-2 text-sm">
                            {log.conversationId && (
                              <div>
                                <span className="font-medium">
                                  {t("auditLog.detail.conversation")}:{" "}
                                </span>
                                <span className="font-mono text-xs">
                                  {log.conversationId}
                                </span>
                              </div>
                            )}
                            {log.error && (
                              <div>
                                <span className="font-medium text-destructive">
                                  {t("auditLog.detail.error")}:{" "}
                                </span>
                                <span>{log.error}</span>
                              </div>
                            )}
                            <div>
                              <span className="font-medium">{t("auditLog.detail.details")}: </span>
                              <pre className="mt-1 rounded bg-muted p-2 text-xs overflow-x-auto">
                                {JSON.stringify(log.details, null, 2)}
                              </pre>
                            </div>
                            {log.output && (
                              <div>
                                <span className="font-medium">{t("auditLog.detail.output")}: </span>
                                <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs max-h-[400px] overflow-y-auto">
                                  {formatOutput(log.output)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>

            <Pager page={page} totalPages={totalPages} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}

/** Format details JSONB into a short readable string. */
function formatDetails(details: Record<string, unknown>): string {
  const entries = Object.entries(details);
  if (entries.length === 0) return "\u2014";
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}

/** Try to pretty-print output JSON, fall back to raw string. */
function formatOutput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
