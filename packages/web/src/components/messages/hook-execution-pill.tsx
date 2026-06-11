// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Webhook, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import type { HookEvent } from "@/lib/api";

/** Minimal shape shared by persisted rows and live SSE summaries. */
export interface HookExecutionView {
  event: HookEvent;
  toolName: string;
  success: boolean;
  error?: string | null;
  durationMs: number;
  args?: Record<string, unknown> | null;
  result?: string | null;
}

/** Pretty-print a stored result: re-indent when it is valid JSON, else as-is. */
function formatResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

/**
 * Compact pill for one lifecycle-hook execution. Clicking it toggles a panel
 * with the rendered tool args (input) and the truncated result (output).
 */
export function HookExecutionPill({
  execution,
  timestamp,
}: {
  execution: HookExecutionView;
  timestamp?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasDetails = execution.args != null || execution.result != null || execution.error != null;

  return (
    <div className="inline-flex max-w-full flex-col">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border bg-background/60 px-2 py-0.5 text-xs text-muted-foreground ${
          hasDetails ? "cursor-pointer transition hover:bg-muted" : "cursor-default"
        }`}
      >
        <Webhook className="h-3 w-3 shrink-0" />
        <span className="shrink-0">{t(`hooks.events.${execution.event}`)}</span>
        <code className="truncate rounded bg-muted px-1">{execution.toolName}</code>
        <span className="shrink-0 tabular-nums">{execution.durationMs}ms</span>
        {execution.success ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 text-destructive">
            <XCircle className="h-3 w-3 shrink-0" />
            {t("hooks.executionFailed")}
          </span>
        )}
        {timestamp && <span className="shrink-0 opacity-60">{timestamp}</span>}
        {hasDetails && (
          <ChevronDown
            className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
      {open && hasDetails && (
        <div className="mt-1 w-fit max-w-full space-y-2 rounded-lg border bg-background/60 p-2 text-left text-xs">
          {execution.error && (
            <p className="whitespace-pre-wrap break-words text-destructive">{execution.error}</p>
          )}
          {execution.args != null && (
            <div>
              <p className="mb-0.5 font-medium text-muted-foreground">{t("message.steps.args")}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-1.5 font-mono">
                {JSON.stringify(execution.args, null, 2)}
              </pre>
            </div>
          )}
          {execution.result != null && (
            <div>
              <p className="mb-0.5 font-medium text-muted-foreground">{t("message.steps.result")}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-1.5 font-mono">
                {formatResult(execution.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
