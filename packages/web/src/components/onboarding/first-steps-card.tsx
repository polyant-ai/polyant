// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Check, ChevronRight, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n/context";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";
import {
  WIZARD_STEP_IDS,
  remainingSteps,
  showFirstStepsCard,
  stepState,
} from "@/lib/onboarding/steps";

/** What is left of the guided setup, shown on the Dashboard after something was skipped. */
export function FirstStepsCard() {
  const { t } = useI18n();
  const { onboarding, openWizard } = useOnboarding();
  if (!onboarding || !showFirstStepsCard(onboarding)) return null;

  const remaining = remainingSteps(onboarding);
  const done = WIZARD_STEP_IDS.length - remaining.length;
  const firstOpen = WIZARD_STEP_IDS.indexOf(remaining[0]);

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
          {remaining.map((id) => {
            const state = stepState(onboarding, id);
            return (
              <li key={id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-accent/50"
                  onClick={() => openWizard(WIZARD_STEP_IDS.indexOf(id))}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground">
                    {state === "skip" ? <Minus className="size-3" /> : <Check className="size-3 opacity-0" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(`onboarding.step.${id}.title`)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(state === "skip" ? "onboarding.firstSteps.skipped" : "onboarding.firstSteps.todo")}
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
