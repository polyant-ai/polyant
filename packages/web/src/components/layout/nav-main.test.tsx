// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { LayoutDashboard } from "lucide-react";
import { isNavActive, NavMain, type NavItem } from "./nav-main";
import { SidebarProvider } from "@/components/ui/sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/organizations/default",
}));

function renderNavMain(items: NavItem[]) {
  // SidebarProvider renders SidebarRail's mobile-breakpoint hook, which needs
  // matchMedia — jsdom does not implement it.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  return render(
    <SidebarProvider>
      <NavMain label="Overview" items={items} />
    </SidebarProvider>,
  );
}

describe("isNavActive", () => {
  it("does not activate a prefix-string sibling (/audit vs /audit-logs)", () => {
    // The reported bug: clicking Tool Traces lit up Audit too.
    expect(isNavActive("/audit-logs", "/audit")).toBe(false);
    expect(isNavActive("/audit-logs", "/audit-logs")).toBe(true);
  });

  it("activates the exact route and its sub-routes", () => {
    expect(isNavActive("/audit-logs", "/audit-logs")).toBe(true);
    expect(isNavActive("/audit-logs/123", "/audit-logs")).toBe(true);
  });

  it("matches the dashboard only on the exact root path", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/instances", "/")).toBe(false);
  });
});

describe("isNavActive with exact", () => {
  it("matches only the exact path when exact is set", () => {
    expect(isNavActive("/organizations/default", "/organizations/default", true)).toBe(true);
    expect(
      isNavActive("/organizations/default/members", "/organizations/default", true),
    ).toBe(false);
  });

  it("still matches sub-routes when exact is not set", () => {
    expect(isNavActive("/organizations/default/members", "/organizations/default")).toBe(true);
  });
});

describe("NavMain disabled items", () => {
  it("renders no link for a disabled item", () => {
    renderNavMain([
      { title: "Conversations", url: "/", icon: LayoutDashboard, disabled: true },
    ]);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Conversations")).toBeInTheDocument();
    expect(screen.getByText("Conversations").closest("button")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("renders a link for an enabled item", () => {
    renderNavMain([{ title: "Dashboard", url: "/organizations/default", icon: LayoutDashboard }]);

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/organizations/default",
    );
  });
});

describe("NavMain once the tenancy resolves", () => {
  it("replaces the disabled placeholders instead of listing them beside the live entries", () => {
    const titles = ["Dashboard", "Agents", "Conversations"];
    const { rerender } = renderNavMain(
      titles.map((title) => ({ title, url: "/", icon: LayoutDashboard, disabled: true, tour: `nav-${title}` })),
    );

    rerender(
      <SidebarProvider>
        <NavMain
          label="Overview"
          items={titles.map((title) => ({
            title,
            url: `/organizations/acme/workspaces/main/${title.toLowerCase()}`,
            icon: LayoutDashboard,
            tour: `nav-${title}`,
          }))}
        />
      </SidebarProvider>,
    );

    for (const title of titles) expect(screen.getAllByText(title)).toHaveLength(1);
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
});
