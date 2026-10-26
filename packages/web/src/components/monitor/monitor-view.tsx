// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailed } from "@/components/ui/load-failed";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { ListHead, ListMetaCell, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { ChipTabs } from "@/components/layout/chip-tabs";
import { api } from "@/lib/api";
import { DEFAULT_MONITOR_LEVEL, itemSummary, monitorLevelView, type MonitorLevel } from "@/lib/monitor/extensions";
import { useResource } from "@/hooks/use-resource";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { useActivityStreamContext } from "@/lib/activity-stream/provider";
import { MONITOR_OUTCOMES_UI } from "@/lib/monitor/outcomes";
import { itemKey, isLive, liveItemFromEvent, liveMatches, withLive, type AnyMonitorItem, type LiveMonitorItem } from "@/lib/monitor/live";
import { MonitorDetailSheet } from "./monitor-detail-sheet";
import { OutcomePill, TypePill, useMonitorLabels } from "./monitor-labels";
import { useMonitorFeed, type MonitorFilters } from "./use-monitor-feed";

/** A stored row appears this long after the live event, so the head is read again then. */
const HEAD_REFRESH_MS = 6_000;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The Monitor: one timeline of what happened, with live updates on top.
 *
 * Filters are held by the caller (`value` / `onChange`) so a page can keep them in the
 * URL and another surface can keep them in memory. `lockedAgent` pins the list to one
 * agent and hides the agent filter: the agent page shows this same component.
 *
 * `level` says which view of the stream it is (the workspace's by default). Same chips,
 * same columns, same drawer at every level; what a level reads from, which chips it
 * starts with and whether it offers an agent filter come from `registerMonitorLevel`.
 *
 * Records in time order: newest first, as the engine and the live stream give them.
 * Search and the chip filters are the engine's (they read the whole timeline, not the
 * rows loaded so far). A row opens its detail drawer.
 */
export function MonitorView({
  value,
  onChange,
  lockedAgent,
  level = DEFAULT_MONITOR_LEVEL,
}: {
  value: MonitorFilters;
  onChange: (next: MonitorFilters) => void;
  lockedAgent?: string;
  level?: MonitorLevel;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const labels = useMonitorLabels();
  const filters = useMemo<MonitorFilters>(() => (lockedAgent ? { ...value, agent: lockedAgent } : value), [value, lockedAgent]);

  // The search box is typed into at once and sent to the engine once typing pauses.
  const [typed, setTyped] = useState(value.q);
  const [prevQ, setPrevQ] = useState(value.q);
  if (value.q !== prevQ) {
    setPrevQ(value.q);
    setTyped(value.q);
  }
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    if (typed === valueRef.current.q) return;
    const timer = setTimeout(() => onChangeRef.current({ ...valueRef.current, q: typed }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const view = monitorLevelView(level);
  const feed = useMonitorFeed(filters, level);
  // The agent filter lists the agents of the one place being read; a wider view spans many.
  const showAgentFilter = !lockedAgent && view.agentFilter;
  const { data: agentsData } = useResource(showAgentFilter ? ["monitor-agents"] : null, () => api.instances.list());
  const agents = agentsData?.instances ?? [];

  // Live rows come from the activity stream the admin layout already holds open.
  const { events, realLive } = useActivityStreamContext();
  // Pausing keeps the live rows as they were at that moment; `null` is "not paused".
  const [frozen, setFrozen] = useState<LiveMonitorItem[] | null>(null);
  const paused = frozen !== null;
  const readable = useMemo(() => feed.types.map((type) => type.type), [feed.types]);
  const liveRows = useMemo(() => {
    const rows: LiveMonitorItem[] = [];
    for (const ev of events) {
      const row = liveItemFromEvent(ev);
      if (
        row &&
        liveMatches(row, {
          group: filters.group || undefined,
          types: filters.type ? [filters.type] : undefined,
          agent: filters.agent || undefined,
          outcome: filters.outcome || undefined,
          q: filters.q || undefined,
          readable: readable.length > 0 ? readable : undefined,
        })
      ) {
        rows.push(row);
      }
    }
    return rows;
  }, [events, filters, readable]);

  const shownLive = frozen ?? liveRows;
  const rows = useMemo(() => withLive(feed.items, shownLive), [feed.items, shownLive]);

  // A live row is replaced by the stored one a moment later: read the head again.
  const newest = shownLive[0] ? itemKey(shownLive[0]) : "";
  const { refreshHead } = feed;
  useEffect(() => {
    if (paused || !newest) return;
    const timer = setTimeout(() => void refreshHead(), HEAD_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [newest, paused, refreshHead]);

  const [selected, setSelected] = useState<AnyMonitorItem | null>(null);

  const togglePause = () => {
    if (!paused) {
      setFrozen(liveRows);
      return;
    }
    setFrozen(null);
    void refreshHead();
  };

  const groups = feed.types.length > 0 ? [...new Set(feed.types.map((type) => type.group))] : view.defaultGroups;
  const tabs = [
    { value: "all", label: t("monitor.group.all") },
    ...groups.map((group) => ({ value: group, label: labels.group(group) })),
  ];

  const retentionDays = (type: string) => feed.types.find((info) => info.type === type)?.retentionDays;
  const telemetryDays = Math.max(0, ...feed.types.map((info) => info.retentionDays ?? 0));
  const filtered = Boolean(filters.group || filters.type || filters.outcome || filters.q || (showAgentFilter && filters.agent));

  const liveLabel = !realLive ? t("monitor.live.offline") : paused ? t("monitor.live.paused") : t("monitor.live.on");
  const liveActive = realLive && !paused;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ChipTabs
          tabs={tabs}
          value={filters.group || "all"}
          onValueChange={(group) => onChange({ ...value, group: group === "all" ? "" : group, type: "" })}
          ariaLabel={t("monitor.groups.label")}
          className="min-w-0"
        />
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <span className="relative inline-flex size-2">
              <span className={`absolute inline-flex h-full w-full rounded-full ${liveActive ? "animate-ping bg-emerald-500/60" : "bg-muted-foreground/30"}`} />
              <span className={`relative inline-flex size-2 rounded-full ${liveActive ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
            </span>
            <span className="font-medium">{liveLabel}</span>
          </span>
          <Button variant="outline" size="sm" onClick={togglePause}>
            {paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
            {paused ? t("monitor.live.resume") : t("monitor.live.pause")}
          </Button>
        </div>
      </div>

      <ListToolbar value={typed} onChange={setTyped} label={t("monitor.filter.search")}>
        {showAgentFilter && (
          <Select value={value.agent || "_all"} onValueChange={(agent) => onChange({ ...value, agent: agent === "_all" ? "" : agent })}>
            <SelectTrigger className="w-full sm:w-[200px]" aria-label={t("monitor.filter.agentLabel")}>
              <SelectValue placeholder={t("monitor.filter.agentAll")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">{t("monitor.filter.agentAll")}</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.slug}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select
          value={value.outcome || "_all"}
          onValueChange={(outcome) => onChange({ ...value, outcome: outcome === "_all" ? "" : (outcome as MonitorFilters["outcome"]) })}
        >
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={t("monitor.filter.outcomeLabel")}>
            <SelectValue placeholder={t("monitor.filter.outcomeAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t("monitor.filter.outcomeAll")}</SelectItem>
            {MONITOR_OUTCOMES_UI.map((outcome) => (
              <SelectItem key={outcome} value={outcome}>
                {t(`monitor.filter.outcome.${outcome}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ListToolbar>

      {filters.type && (
        <div className="flex">
          <button
            type="button"
            onClick={() => onChange({ ...value, type: "" })}
            aria-label={t("monitor.filter.clearType")}
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {t("monitor.filter.onlyType", { type: labels.typeLong(filters.type) })}
            <X className="size-3" aria-hidden />
          </button>
        </div>
      )}

      {feed.error !== undefined ? (
        <LoadFailed onRetry={feed.reload} />
      ) : feed.loading && rows.length === 0 ? (
        <ListLoading className="" />
      ) : rows.length === 0 ? (
        filtered ? (
          <ListNoResults>{t("monitor.empty.filteredTitle")}</ListNoResults>
        ) : (
          <ListEmpty className="mt-10" title={t("monitor.empty.title")} description={t("monitor.empty.description")} />
        )
      ) : (
        <>
          <ListTable className="mt-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <ListHead>{t("monitor.table.summary")}</ListHead>
                <ListHead className="hidden md:table-cell w-[16%]">{t("monitor.table.agent")}</ListHead>
                <ListHead className="w-[130px]">{t("monitor.table.type")}</ListHead>
                <ListHead className="w-[130px]">{t("monitor.table.outcome")}</ListHead>
                <ListHead align="end" className="w-[170px]">{t("monitor.table.time")}</ListHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ListRow
                  key={itemKey(row) + (isLive(row) ? ":live" : "")}
                  onOpen={() => setSelected(row)}
                  selected={selected !== null && itemKey(selected) === itemKey(row) && isLive(selected) === isLive(row)}
                >
                  <ListNameCell name={itemSummary(row, t, fmt.currency)} onOpen={() => setSelected(row)} />
                  <TableCell className="hidden md:table-cell">
                    {row.agent.name || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <TypePill type={row.type} />
                  </TableCell>
                  <TableCell>
                    <OutcomePill outcome={row.outcome} />
                  </TableCell>
                  <ListMetaCell align="end">{fmt.dateTime(row.time)}</ListMetaCell>
                </ListRow>
              ))}
            </TableBody>
          </ListTable>

          {feed.nextCursor && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void feed.loadMore()} disabled={feed.loadingMore}>
                {feed.loadingMore ? t("common.loading") : t("monitor.loadMore")}
              </Button>
            </div>
          )}
        </>
      )}

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{t("monitor.live.note")}</p>
        {telemetryDays > 0 && <p>{t("monitor.retention.note", { days: telemetryDays })}</p>}
      </div>

      <MonitorDetailSheet
        item={selected}
        level={level}
        retentionDays={selected ? retentionDays(selected.type) : undefined}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
