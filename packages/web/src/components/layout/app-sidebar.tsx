// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback } from "react";
import { useParams } from "next/navigation";
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
import { navHref, resolveNavScope, type NavScope } from "@/lib/tenant/nav-href";
import { useTenant } from "@/lib/tenant/tenant-context";
import { isPlatformAdminRole } from "@/lib/user-role";

interface NavItemDef {
  titleKey: TranslationKey;
  /** Path suffix within its scope — "" is the scope root. */
  path: string;
  scope: NavScope;
  icon: LucideIcon;
  exact?: boolean;
}

const overviewDefs: NavItemDef[] = [
  { titleKey: "nav.dashboard", path: "", scope: "org", exact: true, icon: LayoutDashboard },
  { titleKey: "nav.instances", path: "/instances", scope: "workspace", icon: Bot },
  { titleKey: "nav.conversations", path: "/conversations", scope: "workspace", icon: MessageSquare },
  { titleKey: "nav.playground", path: "/playground", scope: "workspace", icon: MessageSquareCode },
  { titleKey: "nav.activity", path: "/activity", scope: "workspace", icon: Activity },
  { titleKey: "nav.memory", path: "/memory", scope: "workspace", icon: Brain },
  // The skill catalog is global — it is NOT workspace-scoped yet, so its URL
  // must not pretend otherwise. See the workspace-scoped-skills spec.
  { titleKey: "nav.skills", path: "/skills", scope: "deployment", icon: Zap },
  { titleKey: "nav.auditLogs", path: "/audit-logs", scope: "org", icon: ScrollText },
];

// Settings is platform-admin-only: it hosts both general system settings and the
// users management tab. Nobody else sees this section at all.
const platformAdminDefs: NavItemDef[] = [
  { titleKey: "nav.members", path: "/members", scope: "org", icon: Users },
  { titleKey: "nav.settings", path: "/settings", scope: "deployment", icon: Settings },
];

export function AppSidebar(
  props: React.ComponentProps<typeof Sidebar> & {
    user?: NavUserProps["user"] & { role?: string };
  },
) {
  const { user, ...sidebarProps } = props;
  const { t } = useI18n();

  const tenant = useTenant();
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();

  // The organization always comes from the verified tenancy (never the URL —
  // see resolveNavScope's doc comment); the workspace is honoured from the URL
  // only when it names a workspace the caller actually holds. Both slugs are
  // plain strings, NOT a wrapper object: an object literal is a new reference
  // every render, so exhaustive-deps would reject it as a dependency (and
  // memoising it would only move the problem).
  const { orgSlug, workspaceSlug } = resolveNavScope(tenant, params);

  const toNavItems = useCallback(
    (defs: NavItemDef[]): NavItem[] =>
      defs.map((d) => ({
        title: t(d.titleKey),
        url: navHref(d.scope, d.path, { orgSlug, workspaceSlug }),
        icon: d.icon,
        exact: d.exact,
        // Deployment items need no tenancy; org/workspace items are disabled
        // until the slug their own scope requires has resolved, so a click
        // during the loading window cannot misnavigate to the dashboard.
        disabled:
          d.scope !== "deployment" && (d.scope === "org" ? !orgSlug : !workspaceSlug),
      })),
    [t, orgSlug, workspaceSlug],
  );

  const isPlatformAdmin = isPlatformAdminRole(user?.role);
  const managementItems = isPlatformAdmin ? platformAdminDefs : [];

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
