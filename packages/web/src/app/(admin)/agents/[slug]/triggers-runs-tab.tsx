// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquare, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { api, getUserErrorMessage, type ScheduledTask, type ConversationListItem } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { ScheduledTaskRunsSection } from "./scheduled-task-runs-section";

interface Props {
  slug: string;
}

type RunType = "all" | "webhook" | "scheduled";

export function TriggersRunsTab({ slug }: Props) {
  const { t } = useI18n();
  const [runType, setRunType] = useState<RunType>("all");
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [webhookConversations, setWebhookConversations] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tasksRes, convRes] = await Promise.all([
        (runType === "webhook") ? Promise.resolve({ tasks: [] }) : api.scheduledTasks.list(slug),
        (runType === "scheduled") ? Promise.resolve({ conversations: [] }) : api.conversations.list({ agentId: slug, source: "webhook", limit: 50 }),
      ]);
      setTasks(tasksRes.tasks ?? []);
      setWebhookConversations(convRes.conversations ?? []);
    } catch (err) {
      toast.error(getUserErrorMessage(err, "Failed to load trigger runs"));
    } finally {
      setLoading(false);
    }
  }, [slug, runType]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Type filter */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{t("triggers.runs.typeFilter")}</span>
        <Select value={runType} onValueChange={(v) => setRunType(v as RunType)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("triggers.runs.typeAll")}</SelectItem>
            <SelectItem value="webhook">{t("triggers.runs.typeWebhook")}</SelectItem>
            <SelectItem value="scheduled">{t("triggers.runs.typeScheduled")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Webhook conversations section */}
      {(runType === "all" || runType === "webhook") && (
        <section className="space-y-3">
          {runType === "all" && (
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {t("triggers.runs.typeWebhook")}
            </h3>
          )}
          {webhookConversations.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
              <MessageSquare className="mx-auto mb-2 size-6" />
              <p className="text-sm">{t("triggers.runs.webhookEmpty")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("triggers.runs.webhookTitle")}</TableHead>
                    <TableHead>{t("triggers.runs.channel")}</TableHead>
                    <TableHead>{t("triggers.runs.messages")}</TableHead>
                    <TableHead>{t("triggers.runs.triggeredAt")}</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {webhookConversations.map((conv) => {
                    // conversationId format: instanceSlug:channelType:target
                    const parts = conv.conversationId.split(":");
                    const channel = parts.length >= 2 ? parts[1] : null;
                    const target = parts.length >= 3 ? parts.slice(2).join(":") : "-";
                    return (
                      <TableRow key={conv.id}>
                        <TableCell className="max-w-[260px]">
                          <div className="truncate font-medium">
                            {conv.title ?? conv.conversationId}
                          </div>
                          {conv.title && (
                            <div className="truncate text-xs text-muted-foreground">
                              {target}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {channel ? (
                            <Badge variant="outline" className="text-xs">{channel}</Badge>
                          ) : "-"}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{conv.messageCount}</span>
                        </TableCell>
                        <TableCell className="text-sm">
                          {conv.createdAt
                            ? new Date(conv.createdAt).toLocaleString()
                            : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          <a
                            href={`/conversations?id=${encodeURIComponent(conv.conversationId)}`}
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="size-3" />
                            {t("triggers.runs.conversationLink")}
                          </a>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      {/* Scheduled task runs section */}
      {(runType === "all" || runType === "scheduled") && (
        <section className="space-y-3">
          {runType === "all" && (
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {t("triggers.runs.typeScheduled")}
            </h3>
          )}
          <ScheduledTaskRunsSection slug={slug} tasks={tasks} />
        </section>
      )}
    </div>
  );
}
