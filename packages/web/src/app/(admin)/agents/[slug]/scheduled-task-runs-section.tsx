// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Wrench,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, getUserErrorMessage, type ScheduledTaskRun, type ScheduledTask } from "@/lib/api";
import { parseUTC, formatRelativeTime, formatDuration } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { MarkdownRenderer } from "@/app/(admin)/playground/_components/markdown-renderer";

interface Props {
  slug: string;
  tasks: ScheduledTask[];
}

const PAGE_SIZE = 20;

function RunStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  switch (status) {
    case "success":
      return (
        <Badge variant="default" className="gap-1">
          <CheckCircle2 className="size-3" />
          {t("scheduledTasks.runs.success")}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="size-3" />
          {t("scheduledTasks.runs.error")}
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          {t("scheduledTasks.runs.running")}
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function ScheduledTaskRunsSection({ slug, tasks }: Props) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterTaskId, setFilterTaskId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const loadRuns = useCallback(async (offset = 0) => {
    try {
      const res = await api.scheduledTasks.runs(slug, {
        taskId: filterTaskId === "all" ? undefined : filterTaskId,
        status: filterStatus === "all" ? undefined : filterStatus,
        limit: PAGE_SIZE,
        offset,
      });
      if (offset === 0) {
        setRuns(res.runs);
      } else {
        setRuns((prev) => [...prev, ...res.runs]);
      }
      setTotal(res.total);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("scheduledTasks.runs.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [slug, filterTaskId, filterStatus, t]);

  useEffect(() => {
    setLoading(true);
    loadRuns(0);
  }, [loadRuns]);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-medium">{t("scheduledTasks.runs.title")}</h3>
          <Badge variant="secondary" className="text-xs">{total}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filterTaskId} onValueChange={setFilterTaskId}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("scheduledTasks.runs.allTasks")}</SelectItem>
              {tasks.map((task) => (
                <SelectItem key={task.id} value={task.id}>{task.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("scheduledTasks.runs.allStatuses")}</SelectItem>
              <SelectItem value="success">{t("scheduledTasks.runs.success")}</SelectItem>
              <SelectItem value="error">{t("scheduledTasks.runs.error")}</SelectItem>
              <SelectItem value="running">{t("scheduledTasks.runs.running")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("scheduledTasks.runs.empty")}
        </div>
      ) : (
        <TooltipProvider>
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t("scheduledTasks.runs.col.task")}</TableHead>
                <TableHead>{t("scheduledTasks.runs.col.status")}</TableHead>
                <TableHead>{t("scheduledTasks.runs.col.trigger")}</TableHead>
                <TableHead>{t("scheduledTasks.runs.col.started")}</TableHead>
                <TableHead>{t("scheduledTasks.runs.col.duration")}</TableHead>
                <TableHead>{t("scheduledTasks.runs.col.output")}</TableHead>
                <TableHead>{t("scheduledTasks.runs.col.tools")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const isExpanded = expandedId === run.id;
                return (
                  <Fragment key={run.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => toggleExpand(run.id)}
                    >
                      <TableCell className="w-8 px-2">
                        {isExpanded
                          ? <ChevronDown className="size-4 text-muted-foreground" />
                          : <ChevronRight className="size-4 text-muted-foreground" />}
                      </TableCell>
                      <TableCell className="font-medium">{run.taskName}</TableCell>
                      <TableCell><RunStatusBadge status={run.status} /></TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {run.triggerType === "manual"
                            ? t("scheduledTasks.runs.manual")
                            : t("scheduledTasks.runs.scheduled")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-sm">
                              {formatRelativeTime(run.startedAt, t)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {run.startedAt ? parseUTC(run.startedAt).toLocaleString() : "-"}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-sm">{formatDuration(run.durationMs)}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                        {run.error
                          ? <span className="text-destructive">{run.error.slice(0, 80)}</span>
                          : (run.output?.slice(0, 80) ?? "-")}
                      </TableCell>
                      <TableCell>
                        {run.toolCalls && run.toolCalls.length > 0 ? (
                          <Badge variant="outline" className="gap-1 text-xs">
                            <Wrench className="size-3" />
                            {run.toolCalls.length}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>

                    {isExpanded && (
                      <TableRow className="bg-muted/30">
                        <TableCell colSpan={8} className="w-0 max-w-0 p-4">
                          <div className="space-y-4 overflow-hidden break-words">
                            {/* Output */}
                            {run.output && (
                              <div>
                                <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                                  {t("scheduledTasks.runs.col.output")}
                                </h4>
                                <div className="overflow-auto rounded-md border bg-background p-3 text-sm">
                                  <MarkdownRenderer content={run.output} />
                                </div>
                              </div>
                            )}

                            {/* Error */}
                            {run.error && (
                              <div>
                                <h4 className="mb-1 text-xs font-medium uppercase text-destructive">
                                  {t("scheduledTasks.runs.error")}
                                </h4>
                                <div className="overflow-hidden break-words rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                                  {run.error}
                                </div>
                              </div>
                            )}

                            {/* Tool Calls */}
                            {run.toolCalls && run.toolCalls.length > 0 && (
                              <div>
                                <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                                  {t("scheduledTasks.runs.toolCalls")}
                                </h4>
                                <div className="space-y-1">
                                  {run.toolCalls.map((tc, i) => (
                                    <div key={i} className="flex items-center gap-2 text-sm">
                                      <Wrench className="size-3 text-muted-foreground" />
                                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{tc.name}</code>
                                      {tc.durationMs !== undefined && (
                                        <span className="text-xs text-muted-foreground">
                                          {formatDuration(tc.durationMs)}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Token usage + Conversation link */}
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                              {run.tokenUsage && (run.tokenUsage.promptTokens || run.tokenUsage.completionTokens) && (
                                <span>
                                  {t("scheduledTasks.runs.tokens")}:{" "}
                                  {(run.tokenUsage.promptTokens ?? 0) + (run.tokenUsage.completionTokens ?? 0)}
                                  {" "}({run.tokenUsage.promptTokens ?? 0} in / {run.tokenUsage.completionTokens ?? 0} out)
                                </span>
                              )}
                              {run.conversationId && (
                                <a
                                  href={`/conversations/${encodeURIComponent(run.conversationId)}`}
                                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ExternalLink className="size-3" />
                                  {t("scheduledTasks.runs.viewConversation")}
                                </a>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          </div>
        </TooltipProvider>
      )}

      {!loading && runs.length < total && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => loadRuns(runs.length)}>
            {t("scheduledTasks.runs.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
