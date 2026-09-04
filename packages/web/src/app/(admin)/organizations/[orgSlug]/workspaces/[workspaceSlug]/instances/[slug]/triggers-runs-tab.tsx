// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquare, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";
import { ScheduledTaskRunsSection } from "./scheduled-task-runs-section";
import { useFormat } from "@/lib/use-format";

/**
 * Which half to render. The Log section titles each block itself — "Webhook",
 * "Programmati" — so a component that always printed both under its own headings
 * produced the doubled titles this replaces.
 */
export type RunsBlock = "webhook" | "scheduled";

interface Props {
  slug: string;
  /** Omit to render both, as the Automazioni page used to. */
  block?: RunsBlock;
}


export function TriggersRunsTab({ slug, block }: Props) {
  const { t } = useI18n();
  const fmt = useFormat();
  const paths = useTenantPaths();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [webhookConversations, setWebhookConversations] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Both, always: with the type filter gone there is no case where one of the
      // two is skipped, so the conditional `Promise.resolve` placeholders it used
      // to need are gone with it.
      const [tasksRes, convRes] = await Promise.all([
        api.scheduledTasks.list(slug),
        api.conversations.list({ instanceId: slug, source: "webhook", limit: 50 }),
      ]);
      setTasks(tasksRes.tasks ?? []);
      setWebhookConversations(convRes.conversations ?? []);
    } catch (err) {
      toast.error(getUserErrorMessage(err, "Failed to load trigger runs"));
    } finally {
      setLoading(false);
    }
  }, [slug]);

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
      {/* No type filter. It selected between two tables whose columns do not
          correspond: a scheduled run has a status, a duration, an output, an error
          and its tool calls (with an expandable row for the full output), while a
          webhook "run" is a CONVERSATION — channel, message count, a link. One
          table would either drop what makes the scheduled view useful or render
          eight columns with half of them empty on every webhook row. So both
          sections simply render, each under its own heading. */}
      {(!block || block === "webhook") && (
      <section className="space-y-3">
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
                            ? fmt.dateTime(conv.createdAt)
                            : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          <a
                            href={paths.workspace(`/conversations?id=${encodeURIComponent(conv.conversationId)}`)}
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

      {(!block || block === "scheduled") && (
      <section className="space-y-3">
        <ScheduledTaskRunsSection slug={slug} tasks={tasks} />
      </section>
      )}
    </div>
  );
}
