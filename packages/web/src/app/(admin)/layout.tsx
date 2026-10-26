// SPDX-License-Identifier: AGPL-3.0-or-later

import { cookies } from "next/headers";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ChangelogUpdateModal } from "@/components/layout/changelog-update-modal";
import { Header } from "@/components/layout/header";
import { OnboardingHost } from "@/components/onboarding/onboarding-host";
import { OnboardingProvider } from "@/lib/onboarding/onboarding-context";
import { ActivityStreamProvider } from "@/lib/activity-stream/provider";
import { auth } from "@/lib/auth";
import { TenantProvider } from "@/lib/tenant/tenant-context";

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
        isPlatformAdmin: sessionUser.isPlatformAdmin,
      }
    : undefined;

  return (
    <TenantProvider>
      <OnboardingProvider isPlatformAdmin={user?.isPlatformAdmin === true}>
      <ActivityStreamProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar user={user} />
          <SidebarInset>
            <Header user={user} />
            <div className="min-w-0 w-full max-w-[1600px] flex-1 self-center p-6 has-[[data-full-bleed]]:max-w-none">{children}</div>
          </SidebarInset>
          <OnboardingHost />
        </SidebarProvider>
      </ActivityStreamProvider>
      <ChangelogUpdateModal />
      </OnboardingProvider>
    </TenantProvider>
  );
}
