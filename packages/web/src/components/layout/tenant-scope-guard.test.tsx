// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { TenantScopeGuard } from "./tenant-scope-guard";
import type { TenantContextValue } from "@/lib/tenant/tenant-context";

const { mockUseTenant, mockNotFound } = vi.hoisted(() => ({
  mockUseTenant: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/tenant/tenant-context", () => ({
  useTenant: () => mockUseTenant(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
}));

vi.mock("./tenant-unavailable", () => ({
  TenantUnavailable: () => <div>tenant-unavailable</div>,
}));

const READY: TenantContextValue = {
  status: "ready",
  organization: { slug: "default", name: "Default" },
  workspaces: [{ slug: "default", name: "Default", isDefault: true }],
  retry: () => {},
};

describe("TenantScopeGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when the slugs match", () => {
    mockUseTenant.mockReturnValue(READY);

    render(
      <TenantScopeGuard orgSlug="default" workspaceSlug="default">
        <div>child</div>
      </TenantScopeGuard>,
    );

    expect(screen.getByText("child")).toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("404s on a mismatched org slug", () => {
    mockUseTenant.mockReturnValue(READY);

    expect(() =>
      render(
        <TenantScopeGuard orgSlug="acme">
          <div>child</div>
        </TenantScopeGuard>,
      ),
    ).toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("404s on a workspace the org does not own", () => {
    mockUseTenant.mockReturnValue(READY);

    expect(() =>
      render(
        <TenantScopeGuard orgSlug="default" workspaceSlug="ghost">
          <div>child</div>
        </TenantScopeGuard>,
      ),
    ).toThrow("NEXT_NOT_FOUND");
  });

  it("renders the fallback, not children, while loading", () => {
    mockUseTenant.mockReturnValue({ status: "loading", retry: () => {} });

    render(
      <TenantScopeGuard orgSlug="default" workspaceSlug="default">
        <div>child</div>
      </TenantScopeGuard>,
    );

    expect(screen.queryByText("child")).not.toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("renders TenantUnavailable when the tenancy cannot be established", () => {
    mockUseTenant.mockReturnValue({ status: "no-organization", retry: () => {} });

    render(
      <TenantScopeGuard orgSlug="default">
        <div>child</div>
      </TenantScopeGuard>,
    );

    expect(screen.getByText("tenant-unavailable")).toBeInTheDocument();
    expect(screen.queryByText("child")).not.toBeInTheDocument();
  });
});
