// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { ListBadgeCell, ListHead, ListMetaCell, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { ListEmpty, ListNoResults } from "@/components/list-states";
import { ListDrawer } from "@/components/list-drawer";
import { useListView } from "@/components/use-list-view";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { useFormat } from "@/lib/use-format";

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

/** A finished event is a good state; one still waiting or being worked on is neutral. */
const backlogTone = (status: string): StatusTone => (status === "completed" ? "positive" : "neutral");

const payloadText = (event: BacklogEvent): string =>
  typeof event.rawPayload === "object" ? JSON.stringify(event.rawPayload) : String(event.rawPayload);

/**
 * The events waiting for the Room agent, per status. Records in time order: the
 * engine's order (newest first) is kept. A row opens the event's full payload.
 */
export function BacklogSection({ backlog, status, onStatusChange }: Props) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const visible = useListView(backlog, search, (event) => [payloadText(event), event.reactNotes, event.status], null);
  const open = backlog.find((event) => event.id === openId) ?? null;

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
        <ListEmpty className="mt-8" title={t("room.backlog.empty")} />
      ) : (
        <div>
          <ListToolbar value={search} onChange={setSearch} />
          {visible.length === 0 ? (
            <ListNoResults />
          ) : (
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ListHead>{t("room.backlog.event")}</ListHead>
                  <ListHead className="w-36">{t("room.backlog.status")}</ListHead>
                  <ListHead className="w-44">{t("room.backlog.received")}</ListHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((event) => (
                  <ListRow key={event.id} onOpen={() => setOpenId(event.id)} selected={openId === event.id}>
                    <ListNameCell
                      name={payloadText(event).slice(0, 120)}
                      onOpen={() => setOpenId(event.id)}
                      summary={event.reactNotes || undefined}
                    />
                    <ListBadgeCell tone={backlogTone(event.status)}>{event.status}</ListBadgeCell>
                    <ListMetaCell>{fmt.dateTime(event.createdAt)}</ListMetaCell>
                  </ListRow>
                ))}
              </TableBody>
            </ListTable>
          )}
        </div>
      )}

      <ListDrawer
        open={open !== null}
        onOpenChange={(next) => !next && setOpenId(null)}
        title={open ? payloadText(open).slice(0, 60) : ""}
        description={open ? fmt.dateTime(open.createdAt) : ""}
        header={open && <StatusBadge tone={backlogTone(open.status)}>{open.status}</StatusBadge>}
      >
        {open && (
          <>
            <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
              {JSON.stringify(open.rawPayload, null, 2)}
            </pre>
            {open.reactNotes && <p className="text-sm">{open.reactNotes}</p>}
          </>
        )}
      </ListDrawer>
    </section>
  );
}
