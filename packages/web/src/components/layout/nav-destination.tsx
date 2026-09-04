// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ACTIVE_ROW_CLASS } from "@/components/layout/nav-main";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import {
  isDestinationItemActive,
  type Destination,
  type DestinationKind,
} from "@/lib/nav/destination";

/** What leaving each destination is called — its parent, named. */
const BACK_LABEL: Record<DestinationKind, TranslationKey> = {
  agent: "nav.instances",
};

/**
 * The sidebar's contents while inside a destination: the way out, the object you
 * are inside, and that destination's sections.
 *
 * Driven entirely by `Destination.groups`, resolved before this renders — so a
 * second destination needs no second component, and two of them cannot come to
 * disagree about what a row looks like.
 */
export function NavDestination({ destination }: { destination: Destination }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab");

  return (
    <>
      <SidebarGroup className="pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t(BACK_LABEL[destination.kind])}>
              <Link href={destination.backHref}>
                <ArrowLeft />
                <span>{t(BACK_LABEL[destination.kind])}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* The object being configured. Hidden when the sidebar is collapsed to
            icons, like the product name in the header: there is no glyph for it. */}
        {destination.subject && (
          <p className="mt-1 truncate px-2 text-sm font-medium group-data-[collapsible=icon]:hidden">
            {destination.subject}
          </p>
        )}
      </SidebarGroup>

      {destination.groups.map((group) => (
        <SidebarGroup key={group.key}>
          {group.labelKey && <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const label = t(item.titleKey);
                const Icon = item.icon;
                const isActive = isDestinationItemActive(item.href, pathname, currentTab);
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      // Weight and a rail, not a filled pill: with every section
                      // its own row the fill read as a selected block in a list
                      // rather than as "you are here".
                      className={cn(isActive && ACTIVE_ROW_CLASS)}
                      tooltip={label}
                    >
                      <Link href={item.href}>
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}
