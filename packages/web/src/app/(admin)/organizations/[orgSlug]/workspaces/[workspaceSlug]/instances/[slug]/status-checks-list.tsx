// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Instance, SkillState, ToolState } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { useStatusChecks } from "./use-status-checks";
import type { AgentCheck, CheckSeverity } from "./status-checks";

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
export function StatusChecks({
  instance,
  tools,
  skills,
}: {
  instance: Instance;
  tools: ToolState[];
  skills: SkillState[];
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { checks, verdict, loading } = useStatusChecks({ instance, tools, skills });

  if (loading) {
    return <Skeleton className="h-28 w-full" />;
  }

  const alerts = checks.filter((c) => c.severity !== "note");
  const notes = checks.filter((c) => c.severity === "note");
  const broken = alerts.filter((c) => c.severity === "broken").length;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-l-[3px] px-4 py-3",
          verdict === "broken"
            ? "border-l-destructive"
            : verdict === "warning"
              ? "border-l-amber-500"
              : "border-l-success",
        )}
      >
        <VerdictIcon verdict={verdict} />
        <span className="text-base font-semibold">{t(`status.verdict.${verdict}`)}</span>
        <span className="text-sm text-muted-foreground">
          {/* No count of "checks passed": the honest number is how many rules were
              evaluated, and only the ones that fired come back from
              `runStatusChecks`. A constant kept beside them would drift the first
              time a rule is added, and a wrong number here is worse than none. */}
          {alerts.length === 0
            ? t("status.verdict.okBody")
            : t("status.verdict.count", {
                broken,
                warning: alerts.length - broken,
              })}
        </span>
      </div>

      {alerts.length > 0 && (
        <div className="divide-y rounded-lg border">
          {alerts.map((check) => (
            <CheckRow key={check.id} check={check} pathname={pathname} />
          ))}
        </div>
      )}

      {notes.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("status.checks.notes")}
          </p>
          <div className="divide-y rounded-lg border">
            {notes.map((check) => (
              <CheckRow key={check.id} check={check} pathname={pathname} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CheckRow({ check, pathname }: { check: AgentCheck; pathname: string }) {
  const { t } = useI18n();

  return (
    <div className="flex items-start gap-3 p-4">
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          check.severity === "broken"
            ? "bg-destructive"
            : check.severity === "warning"
              ? "bg-amber-500"
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
    </div>
  );
}

function VerdictIcon({ verdict }: { verdict: CheckSeverity | "ok" }) {
  if (verdict === "broken") return <CircleAlert className="size-4 text-destructive" />;
  if (verdict === "warning") return <AlertTriangle className="size-4 text-amber-500" />;
  return <CheckCircle2 className="size-4 text-success" />;
}
