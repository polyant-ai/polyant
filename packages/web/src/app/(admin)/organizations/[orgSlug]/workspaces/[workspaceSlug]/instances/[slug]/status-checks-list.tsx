// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { AgentCheck } from "./status-checks";
import type { StatusChecksState } from "./use-status-checks";

/**
 * The verdict and the list of things worth looking at — the only part of Stato
 * that changes on its own, and therefore the reason to come back to the page.
 *
 * Two rules the layout encodes:
 *
 * **Notes are separated and do not reach the verdict.** They are true things that
 * are usually deliberate (no tools on a conversation-only agent, debug
 * left on during a hunt). Mixed into the list they would teach the reader that the
 * list is noise.
 *
 * **Silence is a result, not an empty state.** With nothing to report the block
 * says so and says how many checks ran — an empty area would read as "not loaded
 * yet", which is exactly the wrong reading for a page about whether things work.
 */
export function StatusChecks({ status }: { status: StatusChecksState }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { checks, loading } = status;

  if (loading) {
    return <Skeleton className="h-28 w-full" />;
  }

  const alerts = checks.filter((c) => c.severity !== "note");
  const notes = checks.filter((c) => c.severity === "note");

  return (
    <div className="space-y-4">
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
          <span className="text-[11px] font-bold uppercase tracking-[0.13em] text-muted-foreground">
            {t("status.checks.attention")}
          </span>
          {alerts.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{alerts.length}</span>}
        </div>
        {alerts.length > 0 ? (
          <ul className="divide-y">
            {alerts.map((check) => (
              <CheckRow key={check.id} check={check} pathname={pathname} />
            ))}
          </ul>
        ) : (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" />
            {t("status.verdict.okBody")}
          </div>
        )}
      </Card>

      {notes.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("status.checks.notes")}
          </p>
          <ul className="divide-y rounded-lg border">
            {notes.map((check) => (
              <CheckRow key={check.id} check={check} pathname={pathname} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CheckRow({ check, pathname }: { check: AgentCheck; pathname: string }) {
  const { t } = useI18n();

  return (
    <li className="relative flex items-start gap-3 py-3 pl-4 pr-3 hover:bg-muted">
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-3 left-0 w-[3px] rounded-full",
          check.severity === "broken"
            ? "bg-destructive"
            : check.severity === "warning"
              ? "bg-warning"
              : "bg-muted-foreground/50",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t(check.titleKey, check.params)}</p>
        <p className="text-sm text-muted-foreground">{t(check.bodyKey, check.params)}</p>
      </div>
      <Link
        href={`${pathname}?tab=${check.section}`}
        className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-accent-strong"
      >
        {t(check.sectionKey)}
      </Link>
    </li>
  );
}
