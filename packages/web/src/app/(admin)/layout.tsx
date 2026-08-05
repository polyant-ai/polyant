// SPDX-License-Identifier: AGPL-3.0-or-later

import { cookies } from "next/headers";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Header } from "@/components/layout/header";
import { ActivityStreamProvider } from "@/lib/activity-stream/provider";
import { auth } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [cookieStore, session] = await Promise.all([cookies(), auth()]);
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";
  const sessionUser = session?.user;
  const user = sessionUser
    ? {
        name: sessionUser.name ?? null,
        email: sessionUser.email ?? null,
        image: sessionUser.image ?? null,
        role: sessionUser.role,
      }
    : undefined;

  return (
    <ActivityStreamProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar user={user} />
        <SidebarInset>
          <Header />
          <div className="flex-1 p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </ActivityStreamProvider>
  );
}
