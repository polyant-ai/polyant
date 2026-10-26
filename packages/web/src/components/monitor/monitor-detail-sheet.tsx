// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ListDrawer } from "@/components/list-drawer";
import { LoadFailed } from "@/components/ui/load-failed";
import type { MonitorDetail, MonitorSection } from "@/lib/api";
import { DEFAULT_MONITOR_LEVEL, itemSummary, monitorConversationHref, monitorLevelView, useMonitorEndpoint, type MonitorLevel } from "@/lib/monitor/extensions";
import { formatDuration } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { useResource } from "@/hooks/use-resource";
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";
import { useFormat } from "@/lib/use-format";
import { isLive, type AnyMonitorItem } from "@/lib/monitor/live";
import { isKeptWithConversation, OutcomePill, TypePill, useMonitorLabels } from "./monitor-labels";

/** A plain object with at least one key: what the drawer shows as labelled rows instead of raw JSON. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
    ? (value as Record<string, unknown>)
    : null;
}

/** A section's value as data: text that holds a JSON object is read, anything else stays as it is. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** `customerEmail` and `customer_email` both read as "Customer email". */
function keyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function RowValue({ value }: { value: unknown }) {
  const { t } = useI18n();
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">{"—"}</span>;
  if (typeof value === "boolean") return <>{t(value ? "monitor.detail.yes" : "monitor.detail.no")}</>;
  if (typeof value === "object") {
    // Nested values keep their shape: a formatted block is easier to read than a flattened one.
    return (
      <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-left text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span className="break-words">{String(value)}</span>;
}

function SectionBody({ section }: { section: MonitorSection }) {
  const { t } = useI18n();
  if (section.key === "trigger" && typeof section.value === "string") {
    const key = section.value === "manual" ? "monitor.trigger.manual" : "monitor.trigger.scheduled";
    return <p className="text-sm">{t(key)}</p>;
  }
  const data = parsed(section.value);
  const record = asRecord(data);
  if (record) {
    return (
      <dl className="space-y-2">
        {Object.entries(record).map(([key, value]) => (
          <Field key={key} label={keyLabel(key)}>
            <RowValue value={value} />
          </Field>
        ))}
      </dl>
    );
  }
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (section.kind === "text" && text.length < 80 && !text.includes("\n")) return <p className="text-sm">{text}</p>;
  return (
    <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{text}</pre>
  );
}

/**
 * The link to a conversation, a component of its own because building it needs the workspace
 * of the page (`useTenantPaths` refuses to run without one), which not every Monitor has.
 */
function ConversationLink({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const paths = useTenantPaths();
  return (
    <Button asChild variant="outline">
      <a href={monitorConversationHref(conversationId, paths)}>
        <ExternalLink className="size-4" aria-hidden />
        {t("monitor.detail.openConversation")}
      </a>
    </Button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/**
 * The drawer for one row. A stored row reads its payload from the engine when it
 * opens, so the list stays light; a live row shows the previews the event carried and
 * says that it is provisional.
 */
export function MonitorDetailSheet({
  item,
  level = DEFAULT_MONITOR_LEVEL,
  retentionDays,
  onClose,
}: {
  item: AnyMonitorItem | null;
  level?: MonitorLevel;
  /** How long rows of this item's type are kept; `null` when they have no expiry of their own. */
  retentionDays: number | null | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const labels = useMonitorLabels();
  const endpoint = useMonitorEndpoint(level);
  const live = item !== null && isLive(item);
  const stored = useResource<MonitorDetail>(
    item && !live && endpoint ? ["monitor-detail", endpoint.key, item.type, item.id] : null,
    () => endpoint!.detail(item!.type, item!.id),
  );
  const detail: MonitorDetail | undefined = item ? (live ? item.detail : stored.data) : undefined;

  return (
    <ListDrawer
      open={item !== null}
      onOpenChange={(open) => !open && onClose()}
      title={item ? itemSummary(item, t, fmt.currency) : ""}
      description={item ? labels.typeLong(item.type) : ""}
      // A conversation opens in the workspace it belongs to: only a view that knows the workspace can link it.
      actions={
        item?.conversationId && monitorLevelView(level).conversationLinks ? (
          <ConversationLink conversationId={item.conversationId} />
        ) : undefined
      }
      header={
        item && (
          <div className="flex flex-wrap gap-2 pt-1">
            <TypePill type={item.type} />
            <OutcomePill outcome={item.outcome} />
          </div>
        )
      }
    >
      {item && (
        <>
          <dl className="space-y-2">
            <Field label={t("monitor.detail.time")}>{fmt.dateTime(item.time)}</Field>
            {item.agent.name && <Field label={t("monitor.detail.agent")}>{item.agent.name}</Field>}
            {item.durationMs !== null && <Field label={t("monitor.detail.duration")}>{formatDuration(item.durationMs)}</Field>}
          </dl>

          {live && <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{t("monitor.detail.provisional")}</p>}

          {!live && stored.loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("common.loading")}
            </div>
          )}
          {!live && stored.error !== undefined && (
            <LoadFailed message={t("monitor.detail.loadFailed")} onRetry={stored.reload} className="py-4" />
          )}

          {detail?.error && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-destructive">{t("monitor.detail.error")}</h3>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-3 text-xs">{detail.error}</pre>
            </section>
          )}

          {detail?.sections.map((section) =>
            section.key === "metadata" ? (
              // The stored record of a change (codes, ids, raw keys): there for whoever has to
              // trace it, closed so the drawer opens on who did what to what.
              <details key={section.key} className="space-y-2" data-testid="monitor-technical">
                <summary className="cursor-pointer select-none text-sm font-medium">{labels.section(section.key)}</summary>
                <div className="pt-2">
                  <SectionBody section={section} />
                </div>
              </details>
            ) : (
              <section key={section.key} className="space-y-2">
                <h3 className="text-sm font-medium">{labels.section(section.key)}</h3>
                <SectionBody section={section} />
              </section>
            ),
          )}

          <p className="border-t pt-4 text-xs text-muted-foreground">
            {retentionDays != null
              ? t("monitor.detail.retentionDays", { days: retentionDays })
              : isKeptWithConversation(item.type)
                ? t("monitor.detail.retentionConversation")
                : t("monitor.detail.retentionNone")}
          </p>
        </>
      )}
    </ListDrawer>
  );
}
