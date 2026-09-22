// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import type { AgentCheck } from "./status-checks";

export function CapabilityCheckNotice({
  checks,
  ids,
}: {
  checks: AgentCheck[];
  ids: string[];
}) {
  const { t } = useI18n();
  const visible = checks.filter((check) => ids.includes(check.id));

  if (visible.length === 0) return null;

  return (
    <div className="space-y-2">
      {visible.map((check) => (
        <div
          key={check.id}
          className="flex items-start gap-2 rounded-md border bg-muted/50 p-3"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t(check.titleKey, check.params)}</p>
            <p className="text-sm text-muted-foreground">{t(check.bodyKey, check.params)}</p>
          </div>
          <Link
            href={`?tab=${check.section}`}
            className="shrink-0 text-xs underline underline-offset-4"
          >
            {t(check.sectionKey)}
          </Link>
        </div>
      ))}
    </div>
  );
}
