// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OnboardingState } from "@/lib/api-types";
import { firstOpenStepIndex, remainingSteps, showFirstStepsCard, WIZARD_STEP_IDS } from "./steps";

const base: OnboardingState = { wizard: "new", interfaceTour: "new", agentTour: "new", steps: {} };
const allDone = Object.fromEntries(WIZARD_STEP_IDS.map((id) => [id, "done"])) as OnboardingState["steps"];

describe("First steps card", () => {
  it("is hidden before the wizard has been left", () => {
    expect(showFirstStepsCard(base)).toBe(false);
  });

  it("appears after Skip all", () => {
    expect(showFirstStepsCard({ ...base, wizard: "skipped" })).toBe(true);
  });

  it("appears after the wizard was finished with a step skipped", () => {
    expect(showFirstStepsCard({ ...base, wizard: "done", steps: { ...allDone, knowledge: "skip" } })).toBe(true);
  });

  it("never appears after Don't show again, even with steps skipped", () => {
    expect(showFirstStepsCard({ ...base, wizard: "dismissed", steps: { provider: "skip" } })).toBe(false);
  });

  it("is gone once every step is done", () => {
    expect(showFirstStepsCard({ ...base, wizard: "skipped", steps: allDone })).toBe(false);
  });
});

describe("Resuming", () => {
  it("lists skipped and untouched steps, in wizard order", () => {
    const state = { ...base, wizard: "skipped" as const, steps: { welcome: "done", provider: "skip", agent: "done" } as OnboardingState["steps"] };
    expect(remainingSteps(state)).toEqual(["provider", "model", "chat", "channels", "knowledge"]);
  });

  it("reopens at the first step that is not done", () => {
    expect(firstOpenStepIndex({ ...base, steps: { welcome: "done", provider: "done" } })).toBe(2);
  });
});

describe("Step order", () => {
  it("tries the agent in chat before turning on channels, since the chat needs no channel", () => {
    expect(WIZARD_STEP_IDS).toEqual(["welcome", "provider", "model", "agent", "chat", "channels", "knowledge"]);
  });
});
