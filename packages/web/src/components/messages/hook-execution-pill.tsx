// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { CheckCircle2, Webhook, XCircle } from "lucide-react";
import { ActivityRow } from "./activity-row";
import { useI18n } from "@/lib/i18n/context";
import type { HookEvent } from "@/lib/api";

export interface HookExecutionView {
  event: HookEvent;
  toolName: string;
  success: boolean;
  error?: string | null;
  durationMs: number;
  args?: Record<string, unknown> | null;
  result?: string | null;
}

export function HookExecutionPill({ execution, timestamp }: {
  execution: HookExecutionView;
  timestamp?: string;
}) {
  const { t } = useI18n();
  return (
    <ActivityRow
      icon={<Webhook className="size-3.5" />}
      iconLabel={t("message.activity.hook")}
          tone="hook"
      timestamp={timestamp}
      status={execution.success ? (
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-label={t("message.activity.succeeded")} />
      ) : (
        <XCircle className="size-4 shrink-0 text-destructive" aria-label={t("message.activity.failed")} />
      )}
    >
      {t("message.activity.executed")} <code className="rounded bg-muted px-1 py-0.5 font-semibold">{execution.toolName}</code>{" "}
      {t("message.activity.onEvent")} <code className="rounded bg-muted px-1 py-0.5 font-semibold">{execution.event}</code>
    </ActivityRow>
  );
}
