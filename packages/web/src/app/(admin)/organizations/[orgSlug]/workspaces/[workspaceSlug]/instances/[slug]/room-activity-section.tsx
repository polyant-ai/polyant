// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { ListBadgeCell, ListHead, ListMetaCell, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { ListEmpty, ListNoResults } from "@/components/list-states";
import { ListDrawer } from "@/components/list-drawer";
import { useListView } from "@/components/use-list-view";
import { useI18n } from "@/lib/i18n/context";
import { MarkdownRenderer } from "@/components/messages/markdown-renderer";

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

/** Takes the UI's locale explicitly: a module-level helper has no hook to read it. */
function formatLogDate(dateStr: string, logType: string, locale: string): string {
  const date = new Date(dateStr + "T00:00:00");
  if (logType === "monthly") {
    return date.toLocaleDateString(locale, { month: "long", year: "numeric" });
  }
  if (logType === "weekly") {
    const end = new Date(date);
    end.setDate(end.getDate() + 6);
    return `${date.toLocaleDateString(locale, { day: "numeric", month: "short" })} – ${end.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}`;
  }
  return date.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/**
 * The Room's daily, weekly and monthly summaries. Records in time order: the
 * engine's order (newest first) is kept. A row opens the summary's text.
 */
export function ActivityLogSection({ activity }: Props) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const visible = useListView(
    activity,
    search,
    (log) => [formatLogDate(log.logDate, log.logType, locale), log.logType, log.content],
    null,
  );
  const open = activity.find((log) => log.id === openId) ?? null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t("room.activity.title")}</h2>
      {activity.length === 0 ? (
        <ListEmpty className="mt-8" title={t("room.activity.empty")} />
      ) : (
        <div>
          <ListToolbar value={search} onChange={setSearch} />
          {visible.length === 0 ? (
            <ListNoResults />
          ) : (
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ListHead>{t("room.activity.period")}</ListHead>
                  <ListHead className="w-36">{t("room.activity.type")}</ListHead>
                  <ListHead className="w-28">{t("room.activity.events")}</ListHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((log) => {
                  const label = formatLogDate(log.logDate, log.logType, locale);
                  return (
                    <ListRow key={log.id} onOpen={() => setOpenId(log.id)} selected={openId === log.id}>
                      <ListNameCell name={label} onOpen={() => setOpenId(log.id)} />
                      <ListBadgeCell>{log.logType}</ListBadgeCell>
                      <ListMetaCell>{log.eventCount}</ListMetaCell>
                    </ListRow>
                  );
                })}
              </TableBody>
            </ListTable>
          )}
        </div>
      )}

      <ListDrawer
        open={open !== null}
        onOpenChange={(next) => !next && setOpenId(null)}
        title={open ? formatLogDate(open.logDate, open.logType, locale) : ""}
        description={open ? `${t("room.activity.events")}: ${open.eventCount}` : ""}
        header={open && <Badge variant="secondary">{open.logType}</Badge>}
      >
        {open && <MarkdownRenderer content={open.content} className="text-sm" />}
      </ListDrawer>
    </section>
  );
}
