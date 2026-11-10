// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/** The star that adds an agent to the sidebar's favorites, or takes it off. */
export function FavoriteAgentButton({
  active,
  onToggle,
  className,
}: {
  active: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const label = t(active ? "instances.favorite.remove" : "instances.favorite.add");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn("size-8", className)}
      // Every star carries it; the tour points at the first one on the page.
      data-tour="favorite-agent"
      onClick={(event) => {
        // Inside a row or card that navigates: the star must not open the agent.
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <Star className={cn("size-4", active ? "fill-current text-warning" : "text-muted-foreground")} />
    </Button>
  );
}
