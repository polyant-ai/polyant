// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OnboardingState, WizardStepId, WizardStepState } from "@/lib/api-types";

/**
 * The guided setup, as data. The wizard renders one body per id; everything the
 * rest of the panel needs to know about a step (its order, which need an agent)
 * lives here. so the Dashboard card and the wizard cannot disagree.
 */
export const WIZARD_STEP_IDS: readonly WizardStepId[] = [
  "welcome",
  "provider",
  "model",
  "agent",
  "chat",
  "channels",
  "knowledge",
];

export function stepState(onboarding: OnboardingState, id: WizardStepId): WizardStepState {
  return onboarding.steps[id] ?? "todo";
}

/** The steps still open: skipped or never reached. */
export function remainingSteps(onboarding: OnboardingState): WizardStepId[] {
  return WIZARD_STEP_IDS.filter((id) => stepState(onboarding, id) !== "done");
}

/**
 * Whether the Dashboard shows the "First steps" card.
 *
 * Only after something was skipped, and never after "Don't show again": that
 * choice dismisses the wizard, and a card that kept returning would not honour it.
 */
export function showFirstStepsCard(onboarding: OnboardingState): boolean {
  if (onboarding.wizard === "dismissed" || onboarding.wizard === "new") return false;
  const skippedSomething =
    onboarding.wizard === "skipped" ||
    WIZARD_STEP_IDS.some((id) => stepState(onboarding, id) === "skip");
  return skippedSomething && remainingSteps(onboarding).length > 0;
}

/** Where the wizard reopens: the first step that is not done. */
export function firstOpenStepIndex(onboarding: OnboardingState): number {
  const index = WIZARD_STEP_IDS.findIndex((id) => stepState(onboarding, id) !== "done");
  return Math.max(index, 0);
}
