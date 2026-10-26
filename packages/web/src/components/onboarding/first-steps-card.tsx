// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { Check, ChevronRight, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n/context";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";
import {
  effectiveStepState,
  firstOpenByFacts,
  loadSetupFacts,
  remainingByFacts,
  showSetupCard,
  type SetupFacts,
} from "@/lib/onboarding/setup-state";
import { WIZARD_STEP_IDS } from "@/lib/onboarding/steps";
import { useWorkspaceSlug } from "@/lib/tenant/use-workspace-slug";

/**
 * What is left to set up, on the Dashboard. Each step is read from what exists (a
 * key, an agent, a channel, knowledge, a conversation) rather than from what the
 * wizard recorded, and the card goes away once all are done. Every step is listed,
 * the finished ones ticked and dimmed, so the count in the header matches what is
 * on screen.
 */
export function FirstStepsCard() {
  const { t } = useI18n();
  const { onboarding, openWizard } = useOnboarding();
  const workspaceSlug = useWorkspaceSlug();
  const [loaded, setLoaded] = useState<{ key: string; facts: SetupFacts } | null>(null);
  const key = workspaceSlug ?? "";
  const wanted = !!onboarding && onboarding.wizard !== "dismissed" && onboarding.wizard !== "new";

  useEffect(() => {
    if (!wanted) return;
    let active = true;
    loadSetupFacts()
      .then((facts) => active && setLoaded({ key, facts }))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [wanted, key]);

  const facts = loaded?.key === key ? loaded.facts : null;
  if (!wanted || !onboarding || !facts || !showSetupCard(onboarding, facts)) return null;

  const remaining = remainingByFacts(onboarding, facts);
  const done = WIZARD_STEP_IDS.length - remaining.length;
  const firstOpen = firstOpenByFacts(onboarding, facts);

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t("onboarding.firstSteps.title")}</CardTitle>
          <CardDescription>
            {t("onboarding.firstSteps.progress", { done, total: WIZARD_STEP_IDS.length })}
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => openWizard(firstOpen)}>
          {t("onboarding.firstSteps.resume")}
        </Button>
      </CardHeader>
      <CardContent>
        <progress
          className="sr-only"
          value={done}
          max={WIZARD_STEP_IDS.length}
          aria-label={t("onboarding.firstSteps.title")}
        />
        <div aria-hidden className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary" style={{ width: `${(done / WIZARD_STEP_IDS.length) * 100}%` }} />
        </div>
        <ul className="divide-y">
          {WIZARD_STEP_IDS.map((id) => {
            const state = effectiveStepState(onboarding, facts, id);
            const finished = state === "done";
            return (
              <li key={id} className={finished ? "opacity-60" : undefined} data-state={state}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-accent/50"
                  onClick={() => openWizard(WIZARD_STEP_IDS.indexOf(id))}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground">
                    {state === "skip" ? <Minus className="size-3" /> : <Check className={finished ? "size-3" : "size-3 opacity-0"} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(`onboarding.step.${id}.title`)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(finished ? "onboarding.firstSteps.done" : state === "skip" ? "onboarding.firstSteps.skipped" : "onboarding.firstSteps.todo")}
                      {" · "}
                      {t(`onboarding.step.${id}.subtitle`)}
                    </span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
