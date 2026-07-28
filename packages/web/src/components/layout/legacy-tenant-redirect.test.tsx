// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { LegacyTenantRedirect } from "./legacy-tenant-redirect";
import type { TenantContextValue } from "@/lib/tenant/tenant-context";

const { mockUseTenant, mockNotFound, mockReplace } = vi.hoisted(() => ({
  mockUseTenant: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockReplace: vi.fn(),
}));

vi.mock("@/lib/tenant/tenant-context", () => ({
  useTenant: () => mockUseTenant(),
  defaultWorkspaceSlug: (tenant: TenantContextValue) =>
    tenant.status === "ready" ? (tenant.workspaces[0]?.slug ?? null) : null,
}));

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./tenant-unavailable", () => ({
  TenantUnavailable: () => <div>tenant-unavailable</div>,
}));

describe("LegacyTenantRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s instead of hanging when the org has no workspace to redirect into", () => {
    mockUseTenant.mockReturnValue({
      status: "ready",
      organization: { slug: "acme", name: "Acme" },
      workspaces: [],
      retry: () => {},
    });

    expect(() => render(<LegacyTenantRedirect sub="/instances" />)).toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockNotFound).toHaveBeenCalled();
    // Reverting the fix would fall through to the skeleton and hang forever
    // instead of throwing — this proves that path was never reached.
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
    expect(screen.queryByText("tenant-unavailable")).not.toBeInTheDocument();
  });
});
