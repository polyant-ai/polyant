// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  exact?: boolean;
  /** True while the tenancy needed to resolve `url` is not yet known. */
  disabled?: boolean;
}

// Segment-aware active match: `/audit` must NOT match `/audit-logs`, but
// `/audit-logs` must still match its own sub-routes (`/audit-logs/123`).
// `exact` opts out of the sub-route match — the dashboard sits at the org root,
// which is a prefix of every other org route.
export function isNavActive(pathname: string, url: string, exact = false): boolean {
  if (exact || url === "/") return pathname === url;
  return pathname === url || pathname.startsWith(url + "/");
}

/**
 * What "you are here" looks like on a sidebar row, beyond the shared component's
 * own treatment.
 *
 * shadcn's `SidebarMenuButton` gives the active row `bg-sidebar-accent` and gives
 * HOVER the same background. With a handful of rows that reads as a highlight;
 * with the agent's long column it reads as ambiguity — moving the mouse down
 * lights a second row identical to the lit one, so "where am I" has two answers
 * until the pointer moves away. This adds what hover cannot have: a rule on the
 * leading edge, and full weight.
 *
 * Exported beside `isNavActive` so both nav surfaces read the same answer from
 * one place; two definitions of "active" is the same defect one step removed.
 */
export const ACTIVE_ROW_CLASS =
  "relative font-semibold before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-foreground";

export function NavMain({
  label,
  items,
}: {
  label: string;
  items: NavItem[];
}) {
  const pathname = usePathname();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive = isNavActive(pathname, item.url, item.exact);

            if (item.disabled) {
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton tooltip={item.title} aria-disabled="true">
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  tooltip={item.title}
                  className={cn(isActive && ACTIVE_ROW_CLASS)}
                >
                  <Link href={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
