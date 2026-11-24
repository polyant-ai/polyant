// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat step of the guided setup counts as done only after a successful
 * assistant reply: a reply that failed leaves it open.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnboardingState } from "@/lib/api-types";
import { makeInstance } from "@/test-fixtures/api";

const h = vi.hoisted(() => ({
  update: vi.fn<typeof import("@/lib/api").api.me.updateOnboarding>(),
  create: vi.fn<typeof import("@/lib/api").api.instances.create>(),
  send: vi.fn<typeof import("@/lib/onboarding/wizard-chat").sendWizardChat>(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/organizations/acme/workspaces/general",
  useParams: () => ({ workspaceSlug: "general" }),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      me: { ...actual.api.me, updateOnboarding: h.update },
      models: { list: vi.fn<typeof actual.api.models.list>().mockResolvedValue({ providers: {}, embedders: [] }) },
      instances: {
        ...actual.api.instances,
        list: vi.fn<typeof actual.api.instances.list>().mockResolvedValue({ instances: [] }),
        create: h.create,
        get: vi.fn<typeof actual.api.instances.get>().mockResolvedValue({ instance: makeInstance({ authEnabled: true }) }),
      },
      channels: { ...actual.api.channels, list: vi.fn<typeof actual.api.channels.list>().mockResolvedValue({ channels: [] }) },
      secrets: { ...actual.api.secrets, list: vi.fn<typeof actual.api.secrets.list>().mockResolvedValue({ secrets: [] }) },
    },
  };
});

vi.mock("@/lib/onboarding/wizard-chat", () => ({ sendWizardChat: h.send }));

const ONBOARDING: OnboardingState = { wizard: "skipped", interfaceTour: "done", agentTour: "done", steps: {} };
vi.mock("@/lib/tenant/tenant-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant/tenant-context")>("@/lib/tenant/tenant-context");
  return {
    ...actual,
    useTenant: () => ({
      status: "ready",
      organization: { slug: "acme", name: "Acme" },
      workspaces: [{ slug: "general", name: "General", isDefault: true }],
      onboarding: ONBOARDING,
      retry: () => {},
    }),
  };
});

import { SidebarProvider } from "@/components/ui/sidebar";
import { I18nProvider } from "@/lib/i18n/context";
import { OnboardingProvider } from "@/lib/onboarding/onboarding-context";
import { HelpMenu } from "./help-menu";
import { OnboardingHost } from "./onboarding-host";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockResolvedValue({ onboarding: ONBOARDING });
  h.create.mockResolvedValue({ instance: makeInstance({ slug: "helper", name: "Helper" }) });
});

async function toChat(user: ReturnType<typeof userEvent.setup>) {
  render(
    <I18nProvider initialLocale="en">
      <OnboardingProvider isPlatformAdmin>
        <SidebarProvider>
          <HelpMenu />
          <OnboardingHost />
        </SidebarProvider>
      </OnboardingProvider>
    </I18nProvider>,
  );
  await user.click(screen.getByRole("button", { name: /Help/ }));
  await user.click(await screen.findByRole("menuitem", { name: /Guided setup/ }));
  await screen.findByRole("dialog", { name: "Guided setup" });
  // Provider and model are skipped; the agent is created by name alone.
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Name"), "Helper");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await screen.findByText("Agent created");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Try it in chat" });
}

async function sendAndLeave(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Write a message"), "hello");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {});
  h.update.mockClear();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return h.update.mock.calls.map((c) => c[0]);
}

describe("the chat step", () => {
  it("is recorded as done after an assistant reply", async () => {
    h.send.mockImplementation(async (_slug, _opts, onText) => {
      onText("Hi there");
      return "Hi there";
    });
    const user = userEvent.setup();
    await toChat(user);
    expect(await sendAndLeave(user)).toContainEqual({ steps: { chat: "done" } });
  });

  it("is not recorded as done when the reply was an error", async () => {
    // The break this catches: "Try it in chat" ticked although the answer was an error.
    h.send.mockRejectedValue(new Error("Provider refused the request"));
    const user = userEvent.setup();
    await toChat(user);
    expect(await sendAndLeave(user)).toContainEqual({ steps: { chat: "skip" } });
  });
});
