// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, within } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { I18nProvider } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";
import { AppSidebar } from "./app-sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

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
