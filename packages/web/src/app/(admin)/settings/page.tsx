// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n/context";
import { UsersTab } from "./users-tab";
import { isPlatformAdminRole } from "@/lib/user-role";

export default function SettingsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { data: session, status } = useSession();

  // Defense-in-depth: hide settings entirely from anyone but a platform admin.
  // The sidebar already omits the entry, the engine already gates /api/users
  // with @RequireRole, and this client-side redirect catches anyone reaching
  // the URL directly.
  useEffect(() => {
    if (status === "authenticated" && !isPlatformAdminRole(session?.user?.role)) {
      router.replace("/");
    }
  }, [status, session, router]);

  if (status !== "authenticated" || !isPlatformAdminRole(session?.user?.role)) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("settings.title")}
        </h1>
        <p className="mt-2 text-muted-foreground">{t("settings.subtitle")}</p>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">{t("users.title")}</TabsTrigger>
          <TabsTrigger value="general">{t("settings.tab.general")}</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="pt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="general" className="pt-4">
          <p className="text-sm text-muted-foreground">
            {t("settings.tab.generalEmpty")}
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
