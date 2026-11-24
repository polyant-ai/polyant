// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Languages, LogOut, KeyRound, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import { signOut } from "next-auth/react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { LANGUAGES } from "@/components/layout/lang-toggle";
import type { Locale } from "@/lib/i18n/types";

const THEMES = [
  { value: "light", labelKey: "common.themeLight" },
  { value: "dark", labelKey: "common.themeDark" },
] as const;

export interface NavUserProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

/**
 * The signed-in user's menu, at the far right of the header. It also holds the
 * language and the theme: preferences set once, which need no place in the header.
 */
export function NavUser({ user }: NavUserProps) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const currentLanguage = LANGUAGES.find((l) => l.locale === locale) ?? LANGUAGES[0];
  const currentTheme = THEMES.find((th) => th.value === theme) ?? THEMES[0];
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
          >
            {/* The name lives in text, and the initials are hidden from it: an
                aria-label that did not contain the visible "AB" would fail WCAG 2.5.3. */}
            <span className="sr-only">{t("user.menu")}</span>
            <Avatar aria-hidden className="size-8 ring-1 ring-border">
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="mr-2 size-4" />
              <span className="flex-1">{t("common.language")}</span>
              <span className="text-xs text-muted-foreground">{currentLanguage.label}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                {LANGUAGES.map((lang) => (
                  <DropdownMenuRadioItem key={lang.locale} value={lang.locale} className="gap-2">
                    <lang.flag className="h-3.5 w-5" />
                    {lang.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SunMoon className="mr-2 size-4" />
              <span className="flex-1">{t("common.theme")}</span>
              <span className="text-xs text-muted-foreground">{t(currentTheme.labelKey)}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={currentTheme.value} onValueChange={setTheme}>
                {THEMES.map((th) => (
                  <DropdownMenuRadioItem key={th.value} value={th.value}>
                    {t(th.labelKey)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
