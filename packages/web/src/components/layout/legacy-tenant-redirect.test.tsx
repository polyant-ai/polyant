// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { LegacyTenantRedirect } from "./legacy-tenant-redirect";
import type { TenantContextValue } from "@/lib/tenant/tenant-context";

const { mockUseTenant, mockNotFound, mockReplace, mockSearchParams } = vi.hoisted(() => ({
  mockUseTenant: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockReplace: vi.fn(),
  mockSearchParams: { current: new URLSearchParams() },
}));

// `defaultWorkspaceSlug` is NOT stubbed with its own logic here — a stub that
// re-implements "take workspaces[0]" would bake in the very mutant the isDefault
// preference is supposed to prevent. The real implementation is used.
vi.mock("@/lib/tenant/tenant-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant/tenant-context")>(
    "@/lib/tenant/tenant-context",
  );
  return { ...actual, useTenant: () => mockUseTenant() };
});

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams.current,
}));

vi.mock("./tenant-unavailable", () => ({
  TenantUnavailable: () => <div>tenant-unavailable</div>,
}));

function ready(workspaces: { slug: string; name: string; isDefault: boolean }[]) {
  mockUseTenant.mockReturnValue({
    status: "ready",
    organization: { slug: "acme", name: "Acme" },
    workspaces,
    retry: () => {},
  } satisfies TenantContextValue);
}

const GENERAL = { slug: "general", name: "General", isDefault: true };
const SANDBOX = { slug: "sandbox", name: "Sandbox", isDefault: false };

describe("LegacyTenantRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.current = new URLSearchParams();
  });

  it("forwards a legacy workspace URL to its canonical form", () => {
    ready([GENERAL]);

    render(<LegacyTenantRedirect sub="/instances" />);

    expect(mockReplace).toHaveBeenCalledWith(
      "/organizations/acme/workspaces/general/instances",
    );
  });

  it("preserves the query string of a legacy deep link", () => {
    ready([GENERAL]);
    mockSearchParams.current = new URLSearchParams({ id: "abc", tab: "steps" });

    render(<LegacyTenantRedirect sub="/conversations" />);

    expect(mockReplace).toHaveBeenCalledWith(
      "/organizations/acme/workspaces/general/conversations?id=abc&tab=steps",
    );
  });

  /**
   * The fragment names the thing the reader wanted — a specific message in a
   * conversation. Dropping it lands them at the top of a long page instead, which
   * is the same class of loss as dropping the query string.
   *
   * Read from `window.location`, not from a hook: a fragment is never sent to the
   * server, so Next has no router state for it.
   */
  it("preserves the fragment of a legacy deep link", () => {
    ready([GENERAL]);
    mockSearchParams.current = new URLSearchParams({ id: "agent:web:42" });
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { ...realLocation, hash: "#msg-7" },
      writable: true,
      configurable: true,
    });

    try {
      render(<LegacyTenantRedirect sub="/conversations" />);

      expect(mockReplace).toHaveBeenCalledWith(
        "/organizations/acme/workspaces/general/conversations?id=agent%3Aweb%3A42#msg-7",
      );
    } finally {
      Object.defineProperty(window, "location", {
        value: realLocation,
        writable: true,
        configurable: true,
      });
    }
  });

  it("forwards an org-scoped stub without a workspace segment", () => {
    ready([GENERAL]);

    render(<LegacyTenantRedirect sub="/members" scope="org" />);

    expect(mockReplace).toHaveBeenCalledWith("/organizations/acme/members");
  });

  it("keeps the suffix on an org-scoped forward", () => {
    ready([GENERAL]);
    mockSearchParams.current = new URLSearchParams({ page: "2" });

    render(<LegacyTenantRedirect sub="/audit-logs" scope="org" />);

    expect(mockReplace).toHaveBeenCalledWith("/organizations/acme/audit-logs?page=2");
  });

  // Ordering must not decide this: the default workspace wins even when it is
  // not the first one the API returned.
  it("targets the default workspace, not merely the first", () => {
    ready([SANDBOX, GENERAL]);

    render(<LegacyTenantRedirect sub="/memory" />);

    expect(mockReplace).toHaveBeenCalledWith(
      "/organizations/acme/workspaces/general/memory",
    );
  });

  it("does not redirect while the tenancy is still loading", () => {
    mockUseTenant.mockReturnValue({ status: "loading", retry: () => {} });

    render(<LegacyTenantRedirect sub="/instances" />);

    expect(mockReplace).not.toHaveBeenCalled();
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
