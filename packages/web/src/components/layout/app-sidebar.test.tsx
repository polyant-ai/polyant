// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, within } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { I18nProvider } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";
import { AppSidebar } from "./app-sidebar";
import type { TenantContextValue } from "@/lib/tenant/tenant-context";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  // The nav builds every href from the URL's tenancy — see `resolveNavScope`.
  // No slug here: this test's subject is the footer, so the default workspace
  // the stubbed tenant carries is exactly the scope it should resolve to.
  useParams: () => ({}),
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
          <AppSidebar user={{ name: "Ada Lovelace", email: "ada@example.com", role: "admin" }} />
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
