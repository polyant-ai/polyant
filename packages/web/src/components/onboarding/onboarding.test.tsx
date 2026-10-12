// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First-access guidance as a person meets it: what opens by itself for each
 * stored state, what Skip all / Don't show again record, how the tour moves and
 * ends, when the agent-tour offer appears, and what the Help menu links to.
 * The engine boundary (`api`) is the only thing replaced.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnboardingState } from "@/lib/api-types";

const h = vi.hoisted(() => ({
  pathname: { value: "/organizations/acme" },
  tab: { value: null as string | null },
  params: { value: { workspaceSlug: "general" } as { workspaceSlug?: string } },
  push: vi.fn(),
  replace: vi.fn(),
  update: vi.fn(),
  getInstance: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname.value,
  useParams: () => h.params.value,
  useSearchParams: () => new URLSearchParams(h.tab.value ? `tab=${h.tab.value}` : ""),
  useRouter: () => ({ push: h.push, replace: h.replace }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      me: { ...actual.api.me, updateOnboarding: h.update },
      instances: { ...actual.api.instances, get: h.getInstance, list: vi.fn().mockResolvedValue({ instances: [] }) },
      models: { list: vi.fn().mockResolvedValue({ providers: {}, embedders: [] }) },
    },
  };
});

let onboardingFromEngine: OnboardingState | undefined;
vi.mock("@/lib/tenant/tenant-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant/tenant-context")>("@/lib/tenant/tenant-context");
  return {
    ...actual,
    useTenant: () => ({
      status: "ready",
      organization: { slug: "acme", name: "Acme" },
      workspaces: [{ slug: "general", name: "General", isDefault: true }],
      onboarding: onboardingFromEngine,
      retry: () => {},
    }),
  };
});

import { SidebarProvider } from "@/components/ui/sidebar";
import { I18nProvider } from "@/lib/i18n/context";
import { OnboardingProvider } from "@/lib/onboarding/onboarding-context";
import { HelpMenu } from "./help-menu";
import { OnboardingHost } from "./onboarding-host";

const state = (patch: Partial<OnboardingState> = {}): OnboardingState => ({
  wizard: "new",
  interfaceTour: "new",
  agentTour: "new",
  steps: {},
  ...patch,
});
const SEEN = { wizard: "done", interfaceTour: "done", agentTour: "done" } as const;

/** The elements a tour points at, with a size so they count as visible. */
function Fixture() {
  return (
    <div>
      <div data-tour="dash-tiles">tiles</div>
      <div data-tour="nav">nav</div>
      <a href="#a" data-tour="nav-instances" onClick={(e) => e.preventDefault()}>Agents link</a>
      <button data-tour="new-agent">New agent</button>
      <div data-tour="agent-overview">status</div>
      <HelpMenu />
    </div>
  );
}

function mount(isPlatformAdmin = true) {
  return render(
    <I18nProvider initialLocale="en">
      <OnboardingProvider isPlatformAdmin={isPlatformAdmin}>
        <SidebarProvider>
          <Fixture />
          <OnboardingHost />
        </SidebarProvider>
      </OnboardingProvider>
    </I18nProvider>,
  );
}

const lastPatch = () => h.update.mock.calls.at(-1)?.[0];
const patches = () => h.update.mock.calls.map((c) => c[0]);

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.pathname.value = "/organizations/acme";
  h.tab.value = null;
  h.params.value = { workspaceSlug: "general" };
  h.update.mockResolvedValue({ onboarding: state() });
  h.getInstance.mockResolvedValue({ instance: { slug: "support" } });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 60, width: 200, height: 50, toJSON: () => ({}),
  });
});

describe("what opens by itself", () => {
  it("opens the guided setup full screen for someone who has never seen it", async () => {
    onboardingFromEngine = state();
    mount();
    expect(await screen.findByRole("dialog", { name: "Guided setup" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome to Polyant" })).toBeInTheDocument();
  });

  it("moves to the default workspace before showing the wizard when the URL has none", async () => {
    onboardingFromEngine = state();
    h.params.value = {};
    mount();
    await waitFor(() =>
      expect(h.replace).toHaveBeenCalledWith("/organizations/acme/workspaces/general/instances"),
    );
    expect(screen.queryByRole("dialog", { name: "Guided setup" })).not.toBeInTheDocument();
  });

  it("does not move when the URL already names a workspace", async () => {
    onboardingFromEngine = state();
    mount();
    await screen.findByRole("dialog", { name: "Guided setup" });
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("offers the interface tour, not the wizard, when only the wizard was dismissed", async () => {
    onboardingFromEngine = state({ wizard: "dismissed" });
    mount();
    expect(await screen.findByRole("heading", { name: "The Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Guided setup" })).not.toBeInTheDocument();
    expect(patches()).toContainEqual({ interfaceTour: "seen" });
  });

  it("opens nothing for someone who has seen everything", async () => {
    onboardingFromEngine = state(SEEN);
    mount();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("opens nothing, and writes nothing, when the engine sends no record", async () => {
    onboardingFromEngine = undefined;
    mount();
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("leaving the wizard", () => {
  it("Skip all asks first, then records every step as skipped and offers the tour", async () => {
    onboardingFromEngine = state();
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Skip all" }));
    expect(h.update).not.toHaveBeenCalled(); // the confirm comes first
    await user.click(await screen.findByRole("button", { name: "Yes, skip all" }));

    const patch = patches().find((p) => p.wizard === "skipped");
    expect(patch).toBeDefined();
    expect(patch.steps.provider).toBe("skip");
    expect(patch.steps.welcome).toBe("done");
    expect(await screen.findByRole("heading", { name: "The Dashboard" })).toBeInTheDocument();
    expect(h.push).toHaveBeenCalledWith("/organizations/acme");
  });

  it("Don't show again dismisses only the wizard, and the tour is still offered", async () => {
    onboardingFromEngine = state();
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Don't show again" }));
    await user.click(await screen.findByRole("button", { name: "Yes, don't show again" }));

    expect(patches()).toContainEqual({ wizard: "dismissed" });
    expect(patches().some((p) => "steps" in p)).toBe(false);
    expect(await screen.findByRole("heading", { name: "The Dashboard" })).toBeInTheDocument();
  });

  it("Escape asks to skip instead of closing the wizard silently", async () => {
    onboardingFromEngine = state();
    const user = userEvent.setup();
    mount();
    await screen.findByRole("dialog", { name: "Guided setup" });
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Skip the guided setup?")).toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("walks forward and back through the steps", async () => {
    onboardingFromEngine = state();
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Connect a model provider" })).toBeInTheDocument();
    expect(patches()).toContainEqual({ steps: { welcome: "done" } });
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Welcome to Polyant" })).toBeInTheDocument();
  });
});

describe("the interface tour", () => {
  beforeEach(() => {
    onboardingFromEngine = state({ wizard: "done" });
  });

  it("moves with Next and Back and counts its steps", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole("heading", { name: "The Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("1 of 10")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "The menu" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "The Dashboard" })).toBeInTheDocument();
  });

  it("counts nine steps for someone who is not a Platform Admin", async () => {
    mount(false);
    expect(await screen.findByText("1 of 9")).toBeInTheDocument();
  });

  it("waits for a click on the highlighted element, then moves to the next page", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "The Dashboard" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();

    await user.click(screen.getByText("Agents link"));
    expect(await screen.findByRole("heading", { name: "Create an agent" })).toBeInTheDocument();
    expect(h.push).toHaveBeenCalledWith("/organizations/acme/workspaces/general/instances");
  });

  it("Exit closes it and records nothing more", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "The Dashboard" });
    h.update.mockClear();
    await user.click(screen.getByRole("button", { name: "Exit" }));
    expect(screen.queryByRole("heading", { name: "The Dashboard" })).not.toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("Escape closes it", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "The Dashboard" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "The Dashboard" })).not.toBeInTheDocument();
  });

  it("Don't show again at any step records it as dismissed", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "The Dashboard" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("button", { name: "Don't show again" }));
    expect(lastPatch()).toEqual({ interfaceTour: "dismissed" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("falls back to a centred bubble when the element never appears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}),
      });
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5500);
      });
      expect(screen.getByRole("heading", { name: "The Dashboard" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the agent-tour offer", () => {
  beforeEach(() => {
    onboardingFromEngine = state(SEEN);
    onboardingFromEngine.agentTour = "new";
    h.pathname.value = "/organizations/acme/workspaces/general/instances/support";
  });

  it("appears on a real agent's page and starts the tour on Yes", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText("Want a tour of this page?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(await screen.findByRole("heading", { name: "Status" })).toBeInTheDocument();
    expect(patches()).toContainEqual({ agentTour: "seen" });
  });

  it("does not appear for an agent that does not exist", async () => {
    h.getInstance.mockRejectedValue(new Error("404"));
    mount();
    await waitFor(() => expect(h.getInstance).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("Want a tour of this page?")).not.toBeInTheDocument();
  });

  it("does not appear outside an agent's page", async () => {
    h.pathname.value = "/organizations/acme/workspaces/general/instances";
    mount();
    await act(async () => {});
    expect(screen.queryByText("Want a tour of this page?")).not.toBeInTheDocument();
    expect(h.getInstance).not.toHaveBeenCalled();
  });

  it("does not appear once the tour was seen", async () => {
    onboardingFromEngine = state({ ...SEEN, agentTour: "seen" });
    mount();
    await act(async () => {});
    expect(screen.queryByText("Want a tour of this page?")).not.toBeInTheDocument();
  });

  it("Not now hides it without recording anything", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Want a tour of this page?")).not.toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("Don't show again records it", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Don't show again" }));
    expect(lastPatch()).toEqual({ agentTour: "dismissed" });
  });
});

describe("the Help menu", () => {
  beforeEach(() => {
    onboardingFromEngine = state(SEEN);
  });

  it("links to the documentation, marketplace and product site in a new tab", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /Help/ }));
    const menu = await screen.findByRole("menu");
    for (const [name, href] of [
      ["Documentation", "https://docs.polyant.ai"],
      ["Marketplace", "https://marketplace.polyant.ai"],
      ["Polyant", "https://polyant.ai"],
    ] as const) {
      const link = within(menu).getByRole("menuitem", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("reopens the wizard and the interface tour on request", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /Help/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Interface tour/ }));
    expect(await screen.findByRole("heading", { name: "The Dashboard" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Exit" }));

    await user.click(screen.getByRole("button", { name: /Help/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Guided setup/ }));
    expect(await screen.findByRole("dialog", { name: "Guided setup" })).toBeInTheDocument();
  });

  it("offers the agent tour only on an agent's page", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.click(screen.getByRole("button", { name: /Help/ }));
    expect(screen.queryByRole("menuitem", { name: /Tour of this page/ })).not.toBeInTheDocument();
    first.unmount();

    h.pathname.value = "/organizations/acme/workspaces/general/instances/support";
    mount();
    await user.click(screen.getByRole("button", { name: /Help/ }));
    expect(await screen.findByRole("menuitem", { name: /Tour of this page/ })).toBeInTheDocument();
  });
});
