// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LangToggle } from "@/components/layout/lang-toggle";
import { ActivityTicker } from "@/components/layout/activity-ticker/activity-ticker";

export function Header() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <div className="hidden flex-1 justify-center md:flex">
        <ActivityTicker />
      </div>
      <div className="flex-1 md:hidden" />
      <LangToggle />
      <ThemeToggle />
    </header>
  );
}
