// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";

/**
 * First-access guidance state, one record per user (`users.onboarding`).
 *
 * Bound to the USER, not to a tenant or a browser: a person who has dismissed the
 * wizard on one device or in one organization has dismissed it. The agents the
 * wizard creates are workspace data; whether this person still wants the guidance
 * is not.
 */
export const WIZARD_STATES = ["new", "done", "skipped", "dismissed"] as const;
export const TOUR_STATES = ["new", "seen", "done", "dismissed"] as const;
export const WIZARD_STEPS = [
  "welcome",
  "provider",
  "model",
  "agent",
  "channels",
  "chat",
  "knowledge",
] as const;
export const STEP_STATES = ["todo", "done", "skip"] as const;

export type WizardState = (typeof WIZARD_STATES)[number];
export type TourState = (typeof TOUR_STATES)[number];
export type WizardStep = (typeof WIZARD_STEPS)[number];
export type StepState = (typeof STEP_STATES)[number];

export interface OnboardingState {
  wizard: WizardState;
  interfaceTour: TourState;
  agentTour: TourState;
  /** Steps never touched are absent, which reads as "todo". */
  steps: Partial<Record<WizardStep, StepState>>;
}

/** A partial update: only the keys present are written. */
export type OnboardingPatch = Partial<OnboardingState>;

export const NEW_ONBOARDING: OnboardingState = {
  wizard: "new",
  interfaceTour: "new",
  agentTour: "new",
  steps: {},
};

function pick<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Read a stored value defensively. A NULL column (a user created before anyone
 * saw the guidance) is a user who has not seen it; a malformed value falls back
 * field by field rather than blanking the whole record.
 */
export function normalizeOnboarding(raw: unknown): OnboardingState {
  const src = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const steps: OnboardingState["steps"] = {};
  const rawSteps = src.steps;
  if (rawSteps && typeof rawSteps === "object" && !Array.isArray(rawSteps)) {
    for (const step of WIZARD_STEPS) {
      const state = pick(STEP_STATES, (rawSteps as Record<string, unknown>)[step]);
      if (state) steps[step] = state;
    }
  }
  return {
    wizard: pick(WIZARD_STATES, src.wizard) ?? "new",
    interfaceTour: pick(TOUR_STATES, src.interfaceTour) ?? "new",
    agentTour: pick(TOUR_STATES, src.agentTour) ?? "new",
    steps,
  };
}

/**
 * Validate an UNTRUSTED patch. Only the four known keys, only listed values:
 * there is no DTO validation on this route, and the record is read back by the
 * panel to decide what to open, so a stray key or value must not be stored.
 */
export function parseOnboardingPatch(body: unknown): OnboardingPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Body must be an object");
  }
  const src = body as Record<string, unknown>;
  const known = new Set(["wizard", "interfaceTour", "agentTour", "steps"]);
  for (const key of Object.keys(src)) {
    if (!known.has(key)) throw new BadRequestException(`Unknown onboarding field: ${key}`);
  }
  const patch: OnboardingPatch = {};
  if (src.wizard !== undefined) {
    const v = pick(WIZARD_STATES, src.wizard);
    if (!v) throw new BadRequestException(`wizard must be one of: ${WIZARD_STATES.join(", ")}`);
    patch.wizard = v;
  }
  for (const key of ["interfaceTour", "agentTour"] as const) {
    if (src[key] === undefined) continue;
    const v = pick(TOUR_STATES, src[key]);
    if (!v) throw new BadRequestException(`${key} must be one of: ${TOUR_STATES.join(", ")}`);
    patch[key] = v;
  }
  if (src.steps !== undefined) {
    const rawSteps = src.steps;
    if (!rawSteps || typeof rawSteps !== "object" || Array.isArray(rawSteps)) {
      throw new BadRequestException("steps must be an object");
    }
    const steps: OnboardingState["steps"] = {};
    for (const [step, value] of Object.entries(rawSteps)) {
      const id = pick(WIZARD_STEPS, step);
      if (!id) throw new BadRequestException(`Unknown wizard step: ${step}`);
      const state = pick(STEP_STATES, value);
      if (!state) {
        throw new BadRequestException(`Step ${step} must be one of: ${STEP_STATES.join(", ")}`);
      }
      steps[id] = state;
    }
    patch.steps = steps;
  }
  if (Object.keys(patch).length === 0) {
    throw new BadRequestException("Nothing to update");
  }
  return patch;
}

/** Apply a validated patch: scalar fields replace, steps merge key by key. */
export function applyOnboardingPatch(
  current: OnboardingState,
  patch: OnboardingPatch,
): OnboardingState {
  return {
    wizard: patch.wizard ?? current.wizard,
    interfaceTour: patch.interfaceTour ?? current.interfaceTour,
    agentTour: patch.agentTour ?? current.agentTour,
    steps: { ...current.steps, ...(patch.steps ?? {}) },
  };
}
