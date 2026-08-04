// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { INSTANCE_TAB_GROUPS } from "./instance-tab-groups";

interface InstanceDetailRailProps {
  activeTab: string;
  onSelect: (value: string) => void;
}

/**
 * Vertical rail replacing the agent detail page's twelve horizontal
 * `TabsTrigger`s (design spec, agent-detail phase, phase 10) — mirrors
 * `SettingsRail`'s grouped-list look (`components/layout/settings-rail.tsx`:
 * uppercase group headers, `text-accent-strong` for the active row) so the
 * two surfaces read as one product, per the spec's instruction to match its
 * behaviour and look.
 *
 * Not a reuse of `SettingsRail` itself: that component navigates between
 * distinct routes (`next/link` + `usePathname`), one per Settings section.
 * Here all twelve tabs live on ONE route and switch via the `?tab=` query
 * param + local component state (see `page.tsx`), so items are buttons that
 * call back into the page's existing tab-change handler, not links.
 */
export function InstanceDetailRail({ activeTab, onSelect }: InstanceDetailRailProps) {
  const { t } = useI18n();

  return (
    <nav aria-label={t("instances.detail.railLabel")} className="w-56 shrink-0 space-y-6">
      {INSTANCE_TAB_GROUPS.map((group) => (
        <div key={group.key}>
          <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(group.titleKey)}
          </p>
          <ul className="space-y-1">
            {group.tabs.map((tab) => {
              const active = tab.value === activeTab;
              return (
                <li key={tab.value}>
                  <button
                    type="button"
                    onClick={() => onSelect(tab.value)}
                    // The selected item was conveyed by weight and colour alone.
                    // The Radix `Tabs` this replaced set `aria-selected` for free,
                    // so a screen reader now heard twelve identical buttons with
                    // no indication which one is open.
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center rounded-md px-3 py-2 text-left text-sm",
                      active
                        ? "font-medium text-accent-strong"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {t(tab.labelKey)}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
