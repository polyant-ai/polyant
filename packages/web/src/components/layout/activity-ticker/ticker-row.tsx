// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Clock } from "lucide-react";
import { narrate } from "@/lib/activity-stream/narrative";
import { NarrativeTokenView } from "@/lib/activity-stream/narrative-tokens";
import { useI18n } from "@/lib/i18n/context";
import type { FeedEvent } from "@/lib/activity-stream/types";

interface Props {
  ev: FeedEvent;
}

const FALLBACK_INSTANCE_ICON = "🤖";

function isImageIcon(icon: string): boolean {
  return (
    icon.startsWith("data:") ||
    icon.startsWith("http://") ||
    icon.startsWith("https://") ||
    icon.startsWith("/")
  );
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function TickerAvatar({ icon, name }: { icon: string | null; name: string }) {
  const safeIcon = icon || FALLBACK_INSTANCE_ICON;
  if (isImageIcon(safeIcon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={safeIcon} alt={name} className="size-6 shrink-0 rounded-sm object-cover" />
    );
  }
  return (
    <span
      aria-hidden
      title={name}
      className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-sm text-sm leading-none"
    >
      {safeIcon}
    </span>
  );
}

export function TickerRow({ ev }: Props) {
  const { t } = useI18n();

  const labels = {
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
        createdWithChannel: t("activityStream.narrative.conversation.createdWithChannel"),
        createdNoChannel: t("activityStream.narrative.conversation.createdNoChannel"),
        archived: t("activityStream.narrative.conversation.archived"),
      },
      handoff: {
        running: t("activityStream.narrative.handoff.running"),
        success: t("activityStream.narrative.handoff.success"),
        error: t("activityStream.narrative.handoff.error"),
        done: t("activityStream.narrative.handoff.done"),
      },
    },
  };

  const narrative = narrate(ev, labels);
  const instanceName = ev.instance?.name ?? t("activityStream.fallbackInstance");

  return (
    <div className="flex h-full items-center gap-2 text-sm">
      <TickerAvatar icon={ev.instance?.icon ?? null} name={instanceName} />
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {narrative.tokens.map((tok, i) => (
          <NarrativeTokenView key={i} token={tok} />
        ))}
      </span>
      <span className="text-muted-foreground/70 inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
        <Clock className="size-3" aria-hidden />
        {formatTime(ev.ts)}
      </span>
    </div>
  );
}
