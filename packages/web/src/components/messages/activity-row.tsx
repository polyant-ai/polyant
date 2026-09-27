// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const iconTones = {
  system: "bg-warning/10 text-warning",
  reasoning: "bg-primary/10 text-primary",
  tool: "bg-success/10 text-success",
  hook: "bg-accent/40 text-foreground",
};

export function ActivityRow({ icon, iconLabel, tone, children, detail, timestamp, status }: {
  icon: ReactNode;
  iconLabel: string;
  tone: keyof typeof iconTones;
  children: ReactNode;
  detail?: ReactNode;
  timestamp?: string;
  status?: ReactNode;
}) {
  const line = (
    <span className="flex min-w-0 items-center gap-2 py-2 text-sm text-foreground">
      <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${iconTones[tone]}`} role="img" aria-label={iconLabel}>{icon}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {status}
      {timestamp && <time className="shrink-0 text-xs tabular-nums text-muted-foreground">{timestamp}</time>}
      {detail && <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />}
    </span>
  );
  return detail ? (
    <details className="group border-b border-border last:border-b-0">
      <summary className="cursor-pointer list-none rounded-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">{line}</summary>
      <div className="pb-3 pl-8 text-sm text-muted-foreground">{detail}</div>
    </details>
  ) : <div className="border-b border-border last:border-b-0">{line}</div>;
}
