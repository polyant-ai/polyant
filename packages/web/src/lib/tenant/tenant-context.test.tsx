// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TenantProvider, useTenant, resetTenantCache } from "./tenant-context";

const { mockMeGet } = vi.hoisted(() => ({ mockMeGet: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: { me: { get: (...args: unknown[]) => mockMeGet(...args) } },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

function Probe() {
  const tenant = useTenant();
  return (
    <div>
      <span data-testid="status">{tenant.status}</span>
      {tenant.status === "ready" && <span data-testid="org">{tenant.organization.slug}</span>}
      <button onClick={tenant.retry}>retry</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <TenantProvider>
      <Probe />
    </TenantProvider>,
  );
}

const PAYLOAD = {
  organization: { slug: "default", name: "Default" },
  workspaces: [{ slug: "general", name: "General", isDefault: true }],
};

describe("TenantProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTenantCache();
  });

  it("starts in loading and resolves to ready", async () => {
    mockMeGet.mockResolvedValue(PAYLOAD);

    renderProbe();
    expect(screen.getByTestId("status")).toHaveTextContent("loading");

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("org")).toHaveTextContent("default");
  });

  it("maps a null organization to no-organization", async () => {
    mockMeGet.mockResolvedValue({ ...PAYLOAD, organization: null, workspaces: [] });

    renderProbe();

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("no-organization"),
    );
  });

  it("maps a 403 to no-organization — same legacy token, same remedy", async () => {
    const { ApiError } = await import("@/lib/api");
    mockMeGet.mockRejectedValue(new ApiError(403, "Missing permission: org:read"));

    renderProbe();

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("no-organization"),
    );
  });

  /**
   * 401 is an EXPIRED SESSION, and it must not become `error`. `proxy.ts`
   * excludes `api` from its matcher, so an XHR is never bounced to `/login` —
   * only a full document navigation is. Folded into `error`, the panel showed
   * "the server did not answer, check your connection" with a Retry button that
   * re-fetched, 401'd again, and offered itself forever. The only escape was a
   * manual reload.
   */
  it("maps a 401 to signed-out, not error — Retry cannot fix an expired session", async () => {
    const { ApiError } = await import("@/lib/api");
    mockMeGet.mockRejectedValue(new ApiError(401, "Unauthorized"));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signed-out"));
  });

  it("maps any other failure to error", async () => {
    mockMeGet.mockRejectedValue(new Error("network down"));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
  });

  it("retry refetches after a failure and can succeed", async () => {
    mockMeGet.mockRejectedValueOnce(new Error("network down"));
    mockMeGet.mockResolvedValueOnce(PAYLOAD);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));

    await userEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(mockMeGet).toHaveBeenCalledTimes(2);
  });

  // retry() calls resetTenantCache() itself, so the test above never exercises
  // the module-level cache invariant. The real invariant: after a REJECTED
  // fetch, the cache holds no rejected promise, so a fresh provider mount
  // refetches on its own — no retry() involved.
  it("clears a rejected fetch from the cache — a fresh mount refetches without retry", async () => {
    mockMeGet.mockRejectedValueOnce(new Error("network down"));
    mockMeGet.mockResolvedValueOnce(PAYLOAD);

    const first = renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    first.unmount();

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    expect(mockMeGet).toHaveBeenCalledTimes(2);
  });

  it("fetches once for two providers sharing the module cache", async () => {
    mockMeGet.mockResolvedValue(PAYLOAD);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    renderProbe();
    await waitFor(() => expect(screen.getAllByTestId("status")).toHaveLength(2));

    expect(mockMeGet).toHaveBeenCalledTimes(1);
  });

  it("throws when useTenant is used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/useTenant must be used within TenantProvider/);
  });
});
