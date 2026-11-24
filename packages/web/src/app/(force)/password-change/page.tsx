// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { LogOut } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";
import { ChangePasswordForm } from "@/components/auth/change-password-form";

export default function ForcedPasswordChangePage() {
  const { t } = useI18n();
  const router = useRouter();
  const { data: session, update } = useSession();

  const forced = session?.user?.mustChangePassword === true;

  async function handleSuccess() {
    // An empty patch still makes this a session UPDATE, which re-reads
    // `mustChangePassword` from the database; the value itself is never taken
    // from the client.
    await update({});
    router.replace("/");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {forced ? t("settings.password.forced.title") : t("settings.password.title")}
        </CardTitle>
        <CardDescription>
          {forced
            ? t("settings.password.forced.description")
            : t("settings.password.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ChangePasswordForm forced={forced} onSuccess={handleSuccess} />
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="mr-2 size-4" />
          {t("user.logout")}
        </Button>
      </CardContent>
    </Card>
  );
}
