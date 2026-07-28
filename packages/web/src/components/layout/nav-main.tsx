// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
                <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
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
