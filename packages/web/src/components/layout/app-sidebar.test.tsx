// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, within } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { I18nProvider } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";
import { AppSidebar } from "./app-sidebar";
import type { TenantContextValue } from "@/lib/tenant/tenant-context";

const { mockPathname } = vi.hoisted(() => ({ mockPathname: { value: "/" } }));

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
  // The nav builds every href from the URL's tenancy — see `resolveNavScope`.
  // No slug here: this test's subject is the footer, so the default workspace
  // the stubbed tenant carries is exactly the scope it should resolve to.
  useParams: () => ({}),
  // `NavDestination` reads `?tab=` — the agent's sections share one pathname, so
  // the tab is what marks the active row. No test here asserts a specific tab.
  useSearchParams: () => new URLSearchParams(),
}));

const READY: TenantContextValue = {
  status: "ready",
  organization: { slug: "default", name: "Default" },
  workspaces: [{ slug: "general", name: "General", isDefault: true }],
  retry: () => {},
};

// PARTIAL mock — only the hook is stubbed. `nav-href.ts` imports
// `defaultWorkspaceSlug` from this same module, so replacing it wholesale would
// leave that helper undefined at the first href the sidebar builds.
vi.mock("@/lib/tenant/tenant-context", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tenant/tenant-context")>(
      "@/lib/tenant/tenant-context",
    );
  return { ...actual, useTenant: () => READY };
});

describe("AppSidebar", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  });

  it("shows a versioned About link in the footer without adding it to overview navigation", () => {
    const { container } = render(
      <I18nProvider>
        <SidebarProvider>
          <AppSidebar user={{ name: "Ada Lovelace", email: "ada@example.com", isPlatformAdmin: false }} />
        </SidebarProvider>
      </I18nProvider>,
    );

    const aboutLink = screen.getByRole("link", { name: /informazioni/i });
    expect(aboutLink).toHaveAttribute("href", "/about");
    expect(aboutLink).toHaveTextContent(releaseInfo.version);

    const sidebarContent = container.querySelector<HTMLElement>('[data-sidebar="content"]');
    expect(sidebarContent).not.toBeNull();
    expect(within(sidebarContent!).queryByRole("link", { name: /informazioni/i })).toBeNull();
  });
});

// The property that replaced the agent rail: ONE column of navigation at a time.
// Two adjacent vertical lists at the same visual weight read as one two-level tree
// cut in half — neither can say "you are here", so both try to.
describe("AppSidebar — a destination takes over the sidebar", () => {
  const AGENT = "/organizations/default/workspaces/general/instances/bot-1";

  afterEach(() => {
    mockPathname.value = "/";
  });

  it("shows the agent's sections under their headings, and NOT the daily nav", () => {
    mockPathname.value = AGENT;
    render(
      <I18nProvider>
        <SidebarProvider>
          <AppSidebar user={{ name: "Ada", email: "ada@example.com", isPlatformAdmin: false }} />
        </SidebarProvider>
      </I18nProvider>,
    );

    const content = document.querySelector<HTMLElement>('[data-sidebar="content"]')!;
    // The agent, by its slug, and the way back out.
    expect(within(content).getByText("bot-1")).toBeInTheDocument();
    expect(within(content).getByRole("link", { name: /agenti/i })).toBeInTheDocument();
    // Its macros are HEADINGS now, and each section under them is its own row —
    // it was one row per macro, with the sections behind a tab row.
    expect(within(content).getByText("Comportamento")).toBeInTheDocument();
    expect(within(content).queryByRole("link", { name: /^comportamento$/i })).not.toBeInTheDocument();
    expect(within(content).getByRole("link", { name: /^prompt$/i })).toBeInTheDocument();
    expect(within(content).getByRole("link", { name: /^strumenti$/i })).toBeInTheDocument();

    /*
      And none of the daily work. Conversazioni and Memoria are the trap here:
      they exist under BOTH navigations, so their presence proves nothing — what
      distinguishes them is where they point. Under an agent they address a
      section of that agent, never the workspace-wide page.
    */
    expect(within(content).queryByRole("link", { name: /playground/i })).not.toBeInTheDocument();
    expect(
      within(content).getByRole("link", { name: /^conversazioni$/i }).getAttribute("href"),
    ).toBe(`${AGENT}?tab=conversations`);
  });

  it("shows the daily nav, and no agent entries, everywhere else", () => {
    render(
      <I18nProvider>
        <SidebarProvider>
          <AppSidebar user={{ name: "Ada", email: "ada@example.com", isPlatformAdmin: false }} />
        </SidebarProvider>
      </I18nProvider>,
    );

    const content = document.querySelector<HTMLElement>('[data-sidebar="content"]')!;
    expect(within(content).getByRole("link", { name: /conversazioni/i })).toBeInTheDocument();
    expect(within(content).queryByText("Comportamento")).not.toBeInTheDocument();
    expect(within(content).queryByRole("link", { name: /^prompt$/i })).not.toBeInTheDocument();
  });
});

// Two different gates that used to be one. Members answers to the caller's ROLE
// IN THE ORGANIZATION (`org.member:manage`), which the session does not carry;
// Settings answers to the deployment-wide platform-admin flag, which it does.
// Gating both on the flag hid Members from the org Owner it is for.
describe("AppSidebar — Members is org administration, Settings is platform administration", () => {
  const renderAs = (isPlatformAdmin: boolean) =>
    render(
      <I18nProvider>
        <SidebarProvider>
          <AppSidebar user={{ name: "Ada", email: "ada@example.com", isPlatformAdmin }} />
        </SidebarProvider>
      </I18nProvider>,
    );

  it("offers Members to a non-platform-admin, who may well be the org Owner", () => {
    renderAs(false);

    const content = document.querySelector<HTMLElement>('[data-sidebar="content"]')!;
    expect(within(content).getByRole("link", { name: /membri/i })).toBeInTheDocument();
  });

  it("still keeps Settings to a platform admin", () => {
    renderAs(false);

    const content = document.querySelector<HTMLElement>('[data-sidebar="content"]')!;
    expect(within(content).queryByRole("link", { name: /impostazioni/i })).not.toBeInTheDocument();
  });

  it("shows both to a platform admin", () => {
    renderAs(true);

    const content = document.querySelector<HTMLElement>('[data-sidebar="content"]')!;
    expect(within(content).getByRole("link", { name: /membri/i })).toBeInTheDocument();
    expect(within(content).getByRole("link", { name: /impostazioni/i })).toBeInTheDocument();
  });
});
