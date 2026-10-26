// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { LogOut, KeyRound } from "lucide-react";
import { signOut } from "next-auth/react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";
import { initials } from "@/lib/utils";
import { ChangePasswordForm } from "@/components/auth/change-password-form";

export interface NavUserProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

/** The signed-in user's menu, at the far right of the header. */
export function NavUser({ user }: NavUserProps) {
  const { t } = useI18n();
  const [pwdOpen, setPwdOpen] = useState(false);

  return (
    <>
      <Dialog open={pwdOpen} onOpenChange={setPwdOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.password.title")}</DialogTitle>
            <DialogDescription>{t("settings.password.description")}</DialogDescription>
          </DialogHeader>
          <ChangePasswordForm onSuccess={() => setPwdOpen(false)} />
        </DialogContent>
      </Dialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full p-0 hover:ring-2 hover:ring-ring/40 data-[state=open]:ring-2 data-[state=open]:ring-ring/40"
            aria-label={t("user.menu")}
          >
            <Avatar className="size-8 ring-1 ring-border">
              {user.image && <AvatarImage src={user.image} alt="" />}
              <AvatarFallback>{initials(user.name)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <Avatar size="sm">
                {user.image && <AvatarImage src={user.image} alt={user.name ?? ""} />}
                <AvatarFallback>{initials(user.name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user.name ?? "User"}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setPwdOpen(true)}>
            <KeyRound className="mr-2 size-4" />
            {t("settings.password.title")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/login" })}>
            <LogOut className="mr-2 size-4" />
            {t("user.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
