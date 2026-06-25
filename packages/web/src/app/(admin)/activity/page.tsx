// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { api, type Instance } from "@/lib/api";
import { useActivityStream } from "./_hooks/use-activity-stream";
import { useInstanceFilter } from "./_hooks/use-instance-filter";
import { ActivityFeed } from "./_components/activity-feed";
import { InstanceFilter, type InstanceFilterOption } from "./_components/instance-filter";

export default function ActivityPage() {
  const { t } = useI18n();
  const { events, error, realLive } = useActivityStream();
  const { excluded, toggle, setAll, clear, hydrated } = useInstanceFilter();
  const [instances, setInstances] = useState<Instance[]>([]);
  const indicatorLabel = realLive ? t("activityStream.live") : t("activityStream.offline");

  useEffect(() => {
    api.instances
      .list()
      .then(({ agents }) => setInstances(agents))
      .catch(() => {
        // Best-effort: filter falls back to instances seen in events.
      });
  }, []);

  // Build the option list for the dropdown. Prefer the API result; fall back
  // to whichever instances have appeared in the live feed so the filter still
  // works on a fresh page where the API call hasn't returned yet.
  const filterOptions: InstanceFilterOption[] = useMemo(() => {
    if (instances.length > 0) {
      return instances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        icon: inst.icon ?? null,
      }));
    }
    const seen = new Map<string, InstanceFilterOption>();
    for (const ev of events) {
      if (ev.instance && !seen.has(ev.instance.id)) {
        seen.set(ev.instance.id, {
          id: ev.instance.id,
          name: ev.instance.name,
          icon: ev.instance.icon,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [instances, events]);

  // Hide events from excluded instances. Events without an `instance` (system
  // events) always pass through. Wait until the localStorage hydration ran so
  // the first paint doesn't flash the unfiltered list.
  const visibleEvents = useMemo(() => {
    if (!hydrated || excluded.size === 0) return events;
    return events.filter((ev) => !ev.instance || !excluded.has(ev.instance.id));
  }, [events, excluded, hydrated]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="text-muted-foreground size-5" />
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("activityStream.title")}
            </h1>
          </div>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            {t("activityStream.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {filterOptions.length > 0 && (
            <InstanceFilter
              instances={filterOptions}
              excluded={excluded}
              onToggle={toggle}
              onSelectAll={clear}
              onDeselectAll={() => setAll(filterOptions.map((o) => o.id))}
              labels={{
                title: t("activityStream.filter.title"),
                allSelected: t("activityStream.filter.allSelected"),
                someSelected: (visible, total) =>
                  t("activityStream.filter.someSelected", { visible, total }),
                selectAll: t("activityStream.filter.selectAll"),
                deselectAll: t("activityStream.filter.deselectAll"),
              }}
            />
          )}
          <LiveIndicator label={indicatorLabel} active={realLive} />
        </div>
      </div>

      {error && (
        <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      )}

      <ActivityFeed
        events={visibleEvents}
        emptyText={t("activityStream.empty")}
        labels={{
          openConversation: t("activityStream.openConversation"),
          openInstance: t("activityStream.openInstance"),
          fallbackInstance: t("activityStream.fallbackInstance"),
          meta: t("activityStream.meta"),
          metaFields: {
            channel: t("activityStream.meta.channel"),
            sender: t("activityStream.meta.sender"),
            source: t("activityStream.meta.source"),
            match: t("activityStream.meta.match"),
            action: t("activityStream.meta.action"),
            schedule: t("activityStream.meta.schedule"),
            runId: t("activityStream.meta.runId"),
            trigger: t("activityStream.meta.trigger"),
            gate: t("activityStream.meta.gate"),
            phase: t("activityStream.meta.phase"),
            count: t("activityStream.meta.count"),
            categories: t("activityStream.meta.categories"),
            lifecycle: t("activityStream.meta.lifecycle"),
          },
          kindLabels: {
            tool: t("activityStream.kind.tool"),
            thinking: t("activityStream.kind.thinking"),
            reply: t("activityStream.kind.reply"),
            inbound: t("activityStream.kind.inbound"),
            outbound: t("activityStream.kind.outbound"),
            webhook: t("activityStream.kind.webhook"),
            cron: t("activityStream.kind.cron"),
            memory: t("activityStream.kind.memory"),
            conversation: t("activityStream.kind.conversation"),
            "agent-handoff": t("activityStream.kind.agent-handoff"),
          },
          bodyLabels: {
            tool: t("activityStream.body.tool"),
            thinking: t("activityStream.body.thinking"),
            reply: t("activityStream.body.reply"),
            inbound: t("activityStream.body.inbound"),
            outbound: t("activityStream.body.outbound"),
            webhook: t("activityStream.body.webhook"),
            cron: t("activityStream.body.cron"),
            memory: t("activityStream.body.memory"),
            conversation: t("activityStream.body.conversation"),
            "agent-handoff": t("activityStream.body.agent-handoff"),
          },
          privateBody: {
            inbound: t("activityStream.private.inbound"),
            reply: t("activityStream.private.reply"),
            outbound: t("activityStream.private.outbound"),
          },
          expand: t("activityStream.expand"),
          collapse: t("activityStream.collapse"),
          // Templates are passed as raw i18n strings (with `{key}` placeholders);
          // the narrative layer does the typed-token interpolation so the row
          // renderer can style each substitution differently.
          narrative: {
            subjects: {
              webhook: t("activityStream.narrative.subjects.webhook"),
              cron: t("activityStream.narrative.subjects.cron"),
              conversation: t("activityStream.narrative.subjects.conversation"),
              system: t("activityStream.narrative.subjects.system"),
            },
            templates: {
              tool: {
                running: t("activityStream.narrative.tool.running"),
                success: t("activityStream.narrative.tool.success"),
                error: t("activityStream.narrative.tool.error"),
                done: t("activityStream.narrative.tool.done"),
              },
              thinking: t("activityStream.narrative.thinking"),
              reply: {
                withChannel: t("activityStream.narrative.reply.withChannel"),
                noChannel: t("activityStream.narrative.reply.noChannel"),
              },
              inbound: {
                withSender: t("activityStream.narrative.inbound.withSender"),
                anonymous: t("activityStream.narrative.inbound.anonymous"),
                scheduled: t("activityStream.narrative.inbound.scheduled"),
              },
              outbound: {
                success: t("activityStream.narrative.outbound.success"),
                error: t("activityStream.narrative.outbound.error"),
              },
              webhook: t("activityStream.narrative.webhook"),
              cron: t("activityStream.narrative.cron"),
              memory: t("activityStream.narrative.memory"),
              conversation: {
                createdWithChannel: t(
                  "activityStream.narrative.conversation.createdWithChannel",
                ),
                createdNoChannel: t(
                  "activityStream.narrative.conversation.createdNoChannel",
                ),
                archived: t("activityStream.narrative.conversation.archived"),
              },
              handoff: {
                running: t("activityStream.narrative.handoff.running"),
                success: t("activityStream.narrative.handoff.success"),
                error: t("activityStream.narrative.handoff.error"),
                done: t("activityStream.narrative.handoff.done"),
              },
            },
          },
        }}
      />
    </div>
  );
}

function LiveIndicator({ label, active }: { label: string; active: boolean }) {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <span className="relative inline-flex size-2">
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${active ? "bg-emerald-500/60 animate-ping" : "bg-muted-foreground/30"}`}
        />
        <span
          className={`relative inline-flex size-2 rounded-full ${active ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
        />
      </span>
      <span className="font-medium uppercase tracking-wide">{label}</span>
    </span>
  );
}
