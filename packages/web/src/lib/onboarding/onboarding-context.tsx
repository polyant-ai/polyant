// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api";
import type { OnboardingPatch, OnboardingState } from "@/lib/api-types";
import { useTenant } from "@/lib/tenant/tenant-context";
import type { TourKind } from "./tours";

export interface ActiveTour {
  kind: TourKind;
  index: number;
  /** The agent the agent tour walks, taken from the URL when it started. */
  agentSlug?: string;
}

export interface OnboardingContextValue {
  /** The caller's record; null while loading or when the engine offers none. */
  onboarding: OnboardingState | null;
  isPlatformAdmin: boolean;
  update: (patch: OnboardingPatch) => void;
  wizard: { open: boolean; step: number };
  openWizard: (step?: number) => void;
  closeWizard: () => void;
  /**
   * Ends the wizard with a recorded outcome, then offers the interface tour when
   * the person has not seen it.
   */
  finishWizard: (patch: OnboardingPatch) => void;
  tour: ActiveTour | null;
  startTour: (kind: TourKind, agentSlug?: string) => void;
  setTourIndex: (index: number) => void;
  /** `exit` leaves the record as it is, `done` finishes it, `never` dismisses it. */
  endTour: (outcome: "exit" | "done" | "never") => void;
  /** True while the person said "not now" to the agent-tour prompt on this visit. */
  agentPromptSnoozed: boolean;
  snoozeAgentPrompt: () => void;
  resetAgentPromptSnooze: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function mergeLocal(current: OnboardingState, patch: OnboardingPatch): OnboardingState {
  return {
    wizard: patch.wizard ?? current.wizard,
    interfaceTour: patch.interfaceTour ?? current.interfaceTour,
    agentTour: patch.agentTour ?? current.agentTour,
    steps: { ...current.steps, ...(patch.steps ?? {}) },
  };
}

export function OnboardingProvider({
  isPlatformAdmin,
  children,
}: {
  isPlatformAdmin: boolean;
  children: React.ReactNode;
}) {
  const tenant = useTenant();
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [wizard, setWizard] = useState({ open: false, step: 0 });
  const [tour, setTour] = useState<ActiveTour | null>(null);
  const [agentPromptSnoozed, setAgentPromptSnoozed] = useState(false);
  // The latest record, for callbacks that must not be recreated on every write.
  const latest = useRef<OnboardingState | null>(null);
  const tourRef = useRef<ActiveTour | null>(null);
  useEffect(() => {
    latest.current = onboarding;
    tourRef.current = tour;
  }, [onboarding, tour]);

  // Seed once from the same `/api/me` read the tenancy came from. Later changes
  // are made here first and sent to the engine; the server copy is not re-read.
  const seed = tenant.status === "ready" ? (tenant.onboarding ?? null) : null;
  useEffect(() => {
    if (seed && latest.current === null) {
      // The ref moves with the state: callbacks run by children's effects in the
      // next render must already see the record.
      latest.current = seed;
      setOnboarding(seed);
    }
  }, [seed]);

  const update = useCallback((patch: OnboardingPatch) => {
    const current = latest.current;
    if (!current) return;
    const next = mergeLocal(current, patch);
    latest.current = next;
    setOnboarding(next);
    // Optimistic: a failed write only means the guidance is offered again on the
    // next visit, which is not worth interrupting the person for.
    if (Object.keys(patch).length === 0) return;
    api.me.updateOnboarding(patch).catch(() => {});
  }, []);

  const startTour = useCallback(
    (kind: TourKind, agentSlug?: string) => {
      setWizard((w) => ({ ...w, open: false }));
      setTour({ kind, index: 0, agentSlug });
      const current = latest.current;
      if (!current) return;
      if (kind === "interface" && current.interfaceTour === "new") update({ interfaceTour: "seen" });
      if (kind === "agent" && current.agentTour === "new") update({ agentTour: "seen" });
    },
    [update],
  );

  const endTour = useCallback(
    (outcome: "exit" | "done" | "never") => {
      const active = tourRef.current;
      if (active && outcome !== "exit") {
        const state = outcome === "done" ? "done" : "dismissed";
        update(active.kind === "interface" ? { interfaceTour: state } : { agentTour: state });
      }
      setTour(null);
    },
    [update],
  );

  const openWizard = useCallback((step = 0) => {
    setTour(null);
    setWizard({ open: true, step });
  }, []);

  const closeWizard = useCallback(() => setWizard((w) => ({ ...w, open: false })), []);

  const finishWizard = useCallback(
    (patch: OnboardingPatch) => {
      update(patch);
      setWizard((w) => ({ ...w, open: false }));
      const current = latest.current;
      if (current && current.interfaceTour === "new") startTour("interface");
    },
    [update, startTour],
  );

  const value = useMemo<OnboardingContextValue>(
    () => ({
      onboarding,
      isPlatformAdmin,
      update,
      wizard,
      openWizard,
      closeWizard,
      finishWizard,
      tour,
      startTour,
      setTourIndex: (index) => setTour((t) => (t ? { ...t, index } : t)),
      endTour,
      agentPromptSnoozed,
      snoozeAgentPrompt: () => setAgentPromptSnoozed(true),
      resetAgentPromptSnooze: () => setAgentPromptSnoozed(false),
    }),
    [onboarding, isPlatformAdmin, update, wizard, openWizard, closeWizard, finishWizard, tour, startTour, endTour, agentPromptSnoozed],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within OnboardingProvider");
  return ctx;
}

/** For components that also render outside the provider (the sidebar in tests). */
export function useTourActive(): boolean {
  return useContext(OnboardingContext)?.tour != null;
}
