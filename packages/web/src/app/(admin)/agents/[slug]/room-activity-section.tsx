// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Activity } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { MarkdownRenderer } from "@/app/(admin)/playground/_components/markdown-renderer";

export interface ActivityLog {
  id: string;
  logDate: string;
  logType: string;
  content: string;
  eventCount: number;
  createdAt: string;
}

interface Props {
  activity: ActivityLog[];
}

const TYPE_STYLES: Record<string, string> = {
  daily: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
  weekly: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800",
  monthly: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
};

function formatLogDate(dateStr: string, logType: string): string {
  const date = new Date(dateStr + "T00:00:00");
  if (logType === "monthly") {
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  if (logType === "weekly") {
    const end = new Date(date);
    end.setDate(end.getDate() + 6);
    return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  }
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function ActivityLogEntry({ log }: { log: ActivityLog }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className="mt-0.5 shrink-0"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded
            ? <ChevronDown className="size-4 text-muted-foreground" />
            : <ChevronRight className="size-4 text-muted-foreground" />}
        </button>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-xs font-medium ${TYPE_STYLES[log.logType] ?? ""}`}>
              {log.logType}
            </Badge>
            <span className="text-xs font-medium">{formatLogDate(log.logDate, log.logType)}</span>
            {log.eventCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Activity className="size-3" />
                {log.eventCount}
              </span>
            )}
          </div>
          {expanded && (
            <div className="mt-2 text-muted-foreground">
              <MarkdownRenderer content={log.content} className="text-xs" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ActivityLogSection({ activity }: Props) {
  const { t } = useI18n();

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t("room.activity.title")}</h2>
      {activity.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("room.activity.empty")}</p>
      ) : (
        <div className="rounded-lg border divide-y">
          {activity.map((log) => (
            <ActivityLogEntry key={log.id} log={log} />
          ))}
        </div>
      )}
    </section>
  );
}
