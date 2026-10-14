// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { chipVariants } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

export interface ChipTab {
  value: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  /** Shown after the label. */
  count?: number;
  /** Shown after the label, e.g. an "upgrade required" badge. */
  badge?: ReactNode;
  disabled?: boolean;
  /** The tab's panel. */
  children?: ReactNode;
}

/**
 * Tabs drawn as the chips of the Prompts section: the unstyled Radix primitives
 * give the tablist, arrow-key navigation and selected state; `chipVariants` the look.
 * Controlled through `value`/`onValueChange`; without `value` the first tab opens.
 */
export function ChipTabs({
  tabs,
  value,
  onValueChange,
  ariaLabel,
  className,
  listClassName,
}: {
  tabs: readonly ChipTab[];
  value?: string;
  onValueChange?: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  listClassName?: string;
}) {
  const [own, setOwn] = useState<string | undefined>(undefined);
  const current = value ?? own ?? tabs[0]?.value;
  return (
    <TabsPrimitive.Root
      value={current}
      onValueChange={(next) => {
        setOwn(next);
        onValueChange?.(next);
      }}
      className={cn("flex flex-col gap-0", className)}
    >
      <TabsPrimitive.List aria-label={ariaLabel} className={cn("flex w-full justify-start gap-2 overflow-x-auto", listClassName)}>
        {tabs.map(({ value: tabValue, label, icon: Icon, count, badge, disabled }) => (
          <TabsPrimitive.Trigger
            key={tabValue}
            value={tabValue}
            disabled={disabled}
            className={cn(
              chipVariants({ active: tabValue === current, size: "sm" }),
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
            )}
          >
            {Icon && <Icon className="h-4 w-4 shrink-0" />}
            <span className="truncate">{label}</span>
            {count !== undefined && <span className="text-xs tabular-nums opacity-80">{count}</span>}
            {badge}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((tab) => (
        <TabsPrimitive.Content key={tab.value} value={tab.value}>
          {tab.children}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
