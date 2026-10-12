// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef } from "react";
import { AgentTourPrompt } from "@/components/onboarding/agent-tour-prompt";
import { TourOverlay } from "@/components/onboarding/tour-overlay";
import { Wizard } from "@/components/onboarding/wizard";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";

/**
 * Mounted once in the admin layout. On the first load that carries the person's
 * record it decides what to open: the wizard for someone who has not seen it,
 * otherwise the interface tour for someone who has not seen that. After that it
 * only renders what the rest of the panel asks for.
 */
export function OnboardingHost() {
  const { onboarding, wizard, openWizard, startTour } = useOnboarding();
  const decided = useRef(false);

  useEffect(() => {
    if (!onboarding || decided.current) return;
    decided.current = true;
    if (onboarding.wizard === "new") openWizard(0);
    else if (onboarding.interfaceTour === "new") startTour("interface");
  }, [onboarding, openWizard, startTour]);

  return (
    <>
      {wizard.open && <Wizard />}
      <TourOverlay />
      <AgentTourPrompt />
    </>
  );
}
