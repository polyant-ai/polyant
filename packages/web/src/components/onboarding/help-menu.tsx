// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { usePathname } from "next/navigation";
import { CircleHelp, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n/context";
import { agentFromPath } from "@/lib/nav/destination";
import { HELP_LINKS } from "@/lib/onboarding/help-links";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";
import { firstOpenStepIndex } from "@/lib/onboarding/steps";

/**
 * The header's Help menu: reopen the guidance whenever it is wanted, and reach
 * the documentation. The guided items are offered only when the engine supplied
 * the person's record, so an older engine shows the links alone.
 */
export function HelpMenu() {
  const { t } = useI18n();
  const pathname = usePathname();
  const { onboarding, openWizard, startTour } = useOnboarding();
  const agent = agentFromPath(pathname);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" data-tour="help">
          <CircleHelp className="size-4" />
          <span className="hidden sm:inline">{t("onboarding.help.menu")}</span>
          <span className="sr-only sm:hidden">{t("onboarding.help.menu")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {onboarding && (
          <>
            <DropdownMenuItem onSelect={() => openWizard(firstOpenStepIndex(onboarding))}>
              <div>
                <p className="text-sm font-medium">{t("onboarding.help.wizard")}</p>
                <p className="text-xs text-muted-foreground">{t("onboarding.help.wizardHint")}</p>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => startTour("interface")}>
              <div>
                <p className="text-sm font-medium">{t("onboarding.help.interfaceTour")}</p>
                <p className="text-xs text-muted-foreground">{t("onboarding.help.interfaceTourHint")}</p>
              </div>
            </DropdownMenuItem>
            {agent && (
              <DropdownMenuItem onSelect={() => startTour("agent", agent.agentSlug)}>
                <div>
                  <p className="text-sm font-medium">{t("onboarding.help.agentTour")}</p>
                  <p className="text-xs text-muted-foreground">{t("onboarding.help.agentTourHint")}</p>
                </div>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        {HELP_LINKS.map((link) => (
          <DropdownMenuItem key={link.id} asChild>
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              <span className="flex-1">{t(link.labelKey)}</span>
              <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
