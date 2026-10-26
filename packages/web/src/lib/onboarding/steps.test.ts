// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OnboardingState } from "@/lib/api-types";
import { firstOpenStepIndex, WIZARD_STEP_IDS } from "./steps";

const base: OnboardingState = { wizard: "new", interfaceTour: "new", agentTour: "new", steps: {} };

describe("Resuming", () => {
  it("reopens at the first step that is not done", () => {
    expect(firstOpenStepIndex({ ...base, steps: { welcome: "done", provider: "done" } })).toBe(2);
  });
});

describe("Step order", () => {
  it("tries the agent in chat before turning on channels, since the chat needs no channel", () => {
    expect(WIZARD_STEP_IDS).toEqual(["welcome", "provider", "model", "agent", "chat", "channels", "knowledge"]);
  });
});
