// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The «First steps» card as a person meets it: steps tick from what exists, not
 * from what the wizard recorded, every step is listed, and the card goes away when
 * all are done.
 */

import { act, render, screen } from "@testing-library/react";
import type { OnboardingState } from "@/lib/api-types";

const h = vi.hoisted(() => ({
  onboarding: { value: null as unknown as OnboardingState },
  facts: { value: {} as Record<string, boolean> },
  openWizard: vi.fn(),
}));

vi.mock("@/lib/tenant/use-workspace-slug", () => ({ useWorkspaceSlug: () => "general" }));
vi.mock("@/lib/onboarding/onboarding-context", () => ({
  useOnboarding: () => ({ onboarding: h.onboarding.value, openWizard: h.openWizard }),
}));
vi.mock("@/lib/onboarding/setup-state", async () => {
  const actual = await vi.importActual<typeof import("@/lib/onboarding/setup-state")>("@/lib/onboarding/setup-state");
  return { ...actual, loadSetupFacts: vi.fn(async () => h.facts.value) };
});

import { I18nProvider } from "@/lib/i18n/context";
import { FirstStepsCard } from "./first-steps-card";

const NOTHING = { provider: false, agent: false, model: false, channel: false, knowledge: false, conversation: false };

/** Lets the facts load, so an empty page means «hidden» and not «not yet». */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const mount = () =>
  render(
    <I18nProvider initialLocale="en">
      <FirstStepsCard />
    </I18nProvider>,
  );

beforeEach(() => {
  h.onboarding.value = { wizard: "skipped", interfaceTour: "done", agentTour: "done", steps: { provider: "skip", agent: "skip" } };
  h.facts.value = NOTHING;
});

describe("First steps card", () => {
  it("does not list a step as skipped when the work was done outside the wizard", async () => {
    // The break this catches: «First steps» stuck on «Skipped» after configuring everything elsewhere.
    h.facts.value = { ...NOTHING, provider: true, agent: true };
    mount();
    expect(await screen.findByText("First steps")).toBeInTheDocument();
    expect(screen.queryByText(/Skipped/)).not.toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows.filter((row) => row.getAttribute("data-state") === "done")).toHaveLength(3);
  });

  // The break this catches: «3 of 7 done» above a list that shows only the 4 open steps.
  it("lists all seven steps, the finished ones ticked and dimmed, so the count matches what is shown", async () => {
    h.facts.value = { ...NOTHING, provider: true, agent: true };
    mount();
    expect(await screen.findByText("3 of 7 done")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    const finished = rows.filter((row) => row.getAttribute("data-state") === "done");
    expect(finished).toHaveLength(3);
    for (const row of finished) {
      expect(row.className).toContain("opacity-60");
      expect(row.textContent).toContain("Done");
    }
  });

  it("shows nothing once every step exists", async () => {
    h.facts.value = { provider: true, agent: true, model: true, channel: true, knowledge: true, conversation: true };
    const { container } = mount();
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("waits while the wizard has not been left yet, and stays hidden after «Don't show again»", async () => {
    for (const wizard of ["new", "dismissed"] as const) {
      h.onboarding.value = { wizard, interfaceTour: "done", agentTour: "done", steps: {} };
      const { container, unmount } = mount();
      await settle();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("reopens the wizard at the first step that is still open", async () => {
    h.onboarding.value = { wizard: "skipped", interfaceTour: "done", agentTour: "done", steps: { welcome: "done" } };
    h.facts.value = { ...NOTHING, provider: true, agent: true };
    mount();
    (await screen.findByRole("button", { name: "Resume" })).click();
    // welcome, provider, agent are done; «model» needs a provider AND a model chosen on an agent.
    expect(h.openWizard).toHaveBeenCalledWith(2);
  });
});
