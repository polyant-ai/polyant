// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  LayoutDashboard,
  Bot,
  MessageSquare,
  MessageSquareCode,
  Brain,
  Zap,
  ScrollText,
  Settings,
  Activity,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { NavMain, type NavItem } from "@/components/layout/nav-main";
import { NavUser, type NavUserProps } from "@/components/layout/nav-user";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

interface NavItemDef {
  titleKey: TranslationKey;
  url: string;
  icon: LucideIcon;
}

const overviewDefs: NavItemDef[] = [
  { titleKey: "nav.dashboard", url: "/", icon: LayoutDashboard },
  { titleKey: "nav.instances", url: "/agents", icon: Bot },
  { titleKey: "nav.conversations", url: "/conversations", icon: MessageSquare },
  { titleKey: "nav.playground", url: "/playground", icon: MessageSquareCode },
  { titleKey: "nav.activity", url: "/activity", icon: Activity },
  { titleKey: "nav.memory", url: "/memory", icon: Brain },
  { titleKey: "nav.skills", url: "/skills", icon: Zap },
  { titleKey: "nav.auditLogs", url: "/audit-logs", icon: ScrollText },
];

// Settings is superadmin-only: it hosts both general system settings and the
// users management tab. Non-superadmins don't see this section at all.
const superadminDefs: NavItemDef[] = [
  { titleKey: "nav.members", url: "/members", icon: Users },
  { titleKey: "nav.settings", url: "/settings", icon: Settings },
];

export function AppSidebar(
  props: React.ComponentProps<typeof Sidebar> & {
    user?: NavUserProps["user"] & { role?: string };
  },
) {
  const { user, ...sidebarProps } = props;
  const { t } = useI18n();

  const toNavItems = (defs: NavItemDef[]): NavItem[] =>
    defs.map((d) => ({ title: t(d.titleKey), url: d.url, icon: d.icon }));

  const isSuperadmin = user?.role === "superadmin";
  const managementItems = isSuperadmin ? superadminDefs : [];

  return (
    <Sidebar collapsible="icon" {...sidebarProps}>
      <SidebarHeader>
        <div className="flex h-10 items-center gap-2 px-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" />
          </div>
          <span className="truncate text-base font-semibold group-data-[collapsible=icon]:hidden">
            Polyant
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <NavMain label={t("nav.overview")} items={toNavItems(overviewDefs)} />
        {managementItems.length > 0 && (
          <NavMain label={t("nav.management")} items={toNavItems(managementItems)} />
        )}
      </SidebarContent>

      <SidebarFooter>
        {user && <NavUser user={user} />}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
