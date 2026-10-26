// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

import { ChipTabs } from "@/components/layout/chip-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { useI18n } from "@/lib/i18n/context";
import { UsersTab } from "./users-tab";
import { PlatformTab } from "./platform-tab";

export default function SettingsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { data: session, status } = useSession();

  // Defense-in-depth: hide settings entirely from anyone but a platform admin.
  // The sidebar already omits the entry, the engine already gates /api/users
  // with @PlatformAdminOnly(), and this client-side redirect catches anyone
  // reaching the URL directly. `isPlatformAdmin` is a presentation hint only —
  // the engine is the actual authority and would refuse the API calls anyway.
  useEffect(() => {
    if (status === "authenticated" && session?.user?.isPlatformAdmin !== true) {
      router.replace("/");
    }
  }, [status, session, router]);

  if (status !== "authenticated" || session?.user?.isPlatformAdmin !== true) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
      />

      <ChipTabs
        tabs={[
          { value: "users", label: t("users.title"), children: <div className="pt-4"><UsersTab /></div> },
          { value: "general", label: t("settings.tab.general"), children: <div className="pt-4"><PlatformTab /></div> },
        ]}
      />
    </div>
  );
}
