// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { TourOverlay } from "@/components/onboarding/tour-overlay";
import { Wizard } from "@/components/onboarding/wizard";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";
import { defaultWorkspaceSlug, useTenant } from "@/lib/tenant/tenant-context";
import { workspacePath } from "@/lib/tenant/paths";

/**
 * Mounted once in the admin layout. On the first load that carries the person's
 * record it decides what to open: the wizard for someone who has not seen it,
 * otherwise the interface tour for someone who has not seen that. After that it
 * only renders what the rest of the panel asks for.
 *
 * The wizard creates and configures an agent, and every panel request acts on the
 * workspace in the URL. So it only renders under a workspace route: opened from a
 * URL with none (the organization's Dashboard), the panel first moves to the
 * default workspace and the wizard appears there.
 */
export function OnboardingHost() {
  const { onboarding, wizard, openWizard, startTour } = useOnboarding();
  const decided = useRef(false);
  const tenant = useTenant();
  const params = useParams<{ workspaceSlug?: string }>();
  const router = useRouter();
  const orgSlug = tenant.status === "ready" ? tenant.organization.slug : null;
  const inWorkspace =
    tenant.status === "ready" && !!params.workspaceSlug && tenant.workspaces.some((w) => w.slug === params.workspaceSlug);
  const homeWorkspace = defaultWorkspaceSlug(tenant);

  useEffect(() => {
    if (wizard.open && !inWorkspace && orgSlug && homeWorkspace) {
      router.replace(workspacePath(orgSlug, homeWorkspace, "/instances"));
    }
  }, [wizard.open, inWorkspace, orgSlug, homeWorkspace, router]);

  useEffect(() => {
    if (!onboarding || decided.current) return;
    decided.current = true;
    if (onboarding.wizard === "new") openWizard(0);
    else if (onboarding.interfaceTour === "new") startTour("interface");
  }, [onboarding, openWizard, startTour]);

  return (
    <>
      {wizard.open && inWorkspace && <Wizard />}
      <TourOverlay />
    </>
  );
}
