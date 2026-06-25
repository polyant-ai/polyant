// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { parseUTC } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

export interface BacklogEvent {
  id: string;
  status: string;
  rawPayload: unknown;
  createdAt: string;
  reactNotes: string | null;
}

const BACKLOG_STATUSES = ["pending", "processing", "completed"] as const;

const BACKLOG_STATUS_LABELS: Record<typeof BACKLOG_STATUSES[number], TranslationKey> = {
  pending: "room.backlog.pending",
  processing: "room.backlog.processing",
  completed: "room.backlog.completed",
};

interface Props {
  backlog: BacklogEvent[];
  status: string;
  onStatusChange: (status: string) => void;
}

export function BacklogSection({ backlog, status, onStatusChange }: Props) {
  const { t } = useI18n();
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t("room.backlog.title")}</h2>
      <div className="flex gap-2">
        {BACKLOG_STATUSES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "default" : "outline"}
            onClick={() => onStatusChange(s)}
          >
            {t(BACKLOG_STATUS_LABELS[s])}
          </Button>
        ))}
      </div>
      {backlog.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("room.backlog.empty")}</p>
      ) : (
        <div className="rounded-lg border divide-y">
          {backlog.map((event) => (
            <div key={event.id} className="px-4 py-3 text-sm flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <code className="block text-xs text-muted-foreground truncate">
                  {typeof event.rawPayload === "object" ? JSON.stringify(event.rawPayload).slice(0, 120) : String(event.rawPayload)}
                </code>
                {event.reactNotes && <p className="mt-1 text-xs">{event.reactNotes}</p>}
              </div>
              <div className="shrink-0 text-right">
                <Badge variant="secondary">{event.status}</Badge>
                <p className="mt-1 text-xs text-muted-foreground">{parseUTC(event.createdAt).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
