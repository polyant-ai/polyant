// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MarkdownRenderer } from "@/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/playground/_components/markdown-renderer";
import type { ChangelogEntry } from "@/lib/changelog-types";

interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
  defaultOpen?: boolean;
}

export function ChangelogEntryCard({ entry, defaultOpen = true }: ChangelogEntryCardProps) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-md border border-border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 p-4 text-left">
        <span className="font-mono text-sm font-semibold">v{entry.version}</span>
        <span className="text-xs text-muted-foreground">{entry.date}</span>
        <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="px-4 pb-4">
        {entry.notice && (
          <div className="mb-3 rounded-sm border border-accent-strong/30 bg-accent-strong/5 px-3 py-2 text-xs">
            <MarkdownRenderer content={entry.notice} />
          </div>
        )}

        <div className="space-y-3">
          {entry.changes.map((change) => (
            <div key={change.category}>
              <Badge variant="outline" className="mb-1.5">
                {change.category}
              </Badge>
              <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                {change.items.map((item, idx) => (
                  <li key={idx}>
                    <MarkdownRenderer content={item} className="inline [&_p]:inline" />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
