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

/** Where the wizard reopens: the first step that is not done. */
export function firstOpenStepIndex(onboarding: OnboardingState): number {
  const index = WIZARD_STEP_IDS.findIndex((id) => stepState(onboarding, id) !== "done");
  return Math.max(index, 0);
}
