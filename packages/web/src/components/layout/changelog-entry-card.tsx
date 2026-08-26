// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "@/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/playground/_components/markdown-renderer";
import type { ChangelogEntry } from "@/lib/changelog-types";

interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
}

export function ChangelogEntryCard({ entry }: ChangelogEntryCardProps) {
  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm font-semibold">v{entry.version}</span>
        <span className="text-xs text-muted-foreground">{entry.date}</span>
      </div>

      {entry.notice && (
        <div className="mt-2 rounded-sm border border-accent-strong/30 bg-accent-strong/5 px-3 py-2 text-xs">
          <MarkdownRenderer content={entry.notice} />
        </div>
      )}

      <div className="mt-3 space-y-3">
        {entry.changes.map((change) => (
          <div key={change.category}>
            <Badge variant="outline" className="mb-1.5">
              {change.category}
            </Badge>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {change.items.map((item, idx) => (
                <li key={idx}>
                  <MarkdownRenderer content={item} className="inline [&_p]:inline" />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
