// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The onboarding record is read by the panel to decide whether to open a
 * full-screen wizard, so what these tests pin is what a bad write or a bad read
 * would break: a stray value stored and then trusted, or a NULL column treated
 * as "already seen".
 */

import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  applyOnboardingPatch,
  normalizeOnboarding,
  parseOnboardingPatch,
} from "./onboarding.js";

describe("normalizeOnboarding", () => {
  it("reads a NULL column as a user who has seen nothing", () => {
    expect(normalizeOnboarding(null)).toEqual({
      wizard: "new",
      interfaceTour: "new",
      agentTour: "new",
      steps: {},
    });
  });

  it("falls back field by field when a stored value is not in the allowed set", () => {
    const out = normalizeOnboarding({
      wizard: "skipped",
      interfaceTour: "banana",
      agentTour: 3,
      steps: { provider: "done", agent: "nope", bogus: "done" },
    });
    expect(out).toEqual({
      wizard: "skipped",
      interfaceTour: "new",
      agentTour: "new",
      steps: { provider: "done" },
    });
  });

  it("ignores a non-object steps value", () => {
    expect(normalizeOnboarding({ steps: ["done"] }).steps).toEqual({});
  });
});

describe("parseOnboardingPatch", () => {
  it("accepts every documented value", () => {
    expect(
      parseOnboardingPatch({
        wizard: "dismissed",
        interfaceTour: "seen",
        agentTour: "done",
        steps: { welcome: "done", channels: "skip", chat: "todo" },
      }),
    ).toEqual({
      wizard: "dismissed",
      interfaceTour: "seen",
      agentTour: "done",
      steps: { welcome: "done", channels: "skip", chat: "todo" },
    });
  });

  it.each([
    ["an unknown top-level key", { wizard: "done", isPlatformAdmin: true }],
    ["a wizard value that is a tour value", { wizard: "seen" }],
    ["a tour value that is a wizard value", { interfaceTour: "skipped" }],
    ["a non-string value", { agentTour: 1 }],
    ["an unknown step", { steps: { teleport: "done" } }],
    ["an unknown step state", { steps: { agent: "finished" } }],
    ["steps as an array", { steps: ["agent"] }],
    ["an empty patch", {}],
    ["a non-object body", "wizard"],
    ["a null body", null],
    ["an array body", [{ wizard: "done" }]],
  ])("rejects %s", (_label, body) => {
    expect(() => parseOnboardingPatch(body)).toThrow(BadRequestException);
  });
});

describe("applyOnboardingPatch", () => {
  const base = normalizeOnboarding({
    wizard: "skipped",
    interfaceTour: "seen",
    agentTour: "new",
    steps: { provider: "skip", model: "skip" },
  });

  it("touches only the keys present and merges steps key by key", () => {
    expect(applyOnboardingPatch(base, { agentTour: "dismissed", steps: { provider: "done" } })).toEqual({
      wizard: "skipped",
      interfaceTour: "seen",
      agentTour: "dismissed",
      steps: { provider: "done", model: "skip" },
    });
  });

  it("does not mutate the current record", () => {
    applyOnboardingPatch(base, { wizard: "done", steps: { agent: "done" } });
    expect(base.wizard).toBe("skipped");
    expect(base.steps).toEqual({ provider: "skip", model: "skip" });
  });
});
