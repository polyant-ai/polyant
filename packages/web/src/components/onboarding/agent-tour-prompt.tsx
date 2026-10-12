// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { agentFromPath } from "@/lib/nav/destination";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";

/**
 * The small offer made the first time a real agent's page opens. It never starts
 * the tour by itself. "Not now" hides it for this visit only; "Don't show again"
 * records the choice.
 */
export function AgentTourPrompt() {
  const { t } = useI18n();
  const pathname = usePathname();
  const { onboarding, tour, wizard, startTour, update, agentPromptSnoozed, snoozeAgentPrompt, resetAgentPromptSnooze } =
    useOnboarding();
  const slug = agentFromPath(pathname)?.agentSlug ?? null;
  // The agent the offer was verified for: the URL alone could name an agent that does not exist.
  const [verifiedSlug, setVerifiedSlug] = useState<string | null>(null);

  const wanted = !!slug && onboarding?.agentTour === "new";

  useEffect(() => {
    if (!slug) resetAgentPromptSnooze();
  }, [slug, resetAgentPromptSnooze]);

  useEffect(() => {
    if (!wanted || !slug) return;
    let active = true;
    api.instances
      .get(slug)
      .then(() => {
        if (active) setVerifiedSlug(slug);
      })
      .catch(() => {
        if (active) setVerifiedSlug(null);
      });
    return () => {
      active = false;
    };
  }, [wanted, slug]);

  useEffect(() => {
    if (!wanted || verifiedSlug !== slug) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") snoozeAgentPrompt();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wanted, verifiedSlug, slug, snoozeAgentPrompt]);

  if (!wanted || verifiedSlug !== slug || !slug || tour || wizard.open || agentPromptSnoozed) return null;

  return (
    <section
      aria-label={t("onboarding.agentPrompt.title")}
      className="fixed bottom-4 right-4 left-4 z-[60] rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg sm:left-auto sm:max-w-xs"
    >
      <p className="text-sm font-medium">{t("onboarding.agentPrompt.title")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => startTour("agent", slug)}>
          {t("onboarding.agentPrompt.yes")}
        </Button>
        <Button size="sm" variant="outline" onClick={snoozeAgentPrompt}>
          {t("onboarding.agentPrompt.notNow")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => update({ agentTour: "dismissed" })}>
          {t("onboarding.never")}
        </Button>
      </div>
    </section>
  );
}
