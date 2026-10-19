// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks ────────────────────────────────────────────────────────────

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockRemove = vi.fn();
const mockToastError = vi.fn();

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

vi.mock("@/lib/api", () => ({
  api: {
    apiKeys: {
      list: (...args: unknown[]) => mockList(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      remove: (...args: unknown[]) => mockRemove(...args),
    },
  },
  getUserErrorMessage: (_err: unknown, fallback: string) => fallback,
  isForbidden: (err: unknown) => err instanceof ApiError && err.status === 403,
}));

const i18n = { t: (key: string) => key, locale: "en", setLocale: () => {} };
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => i18n }));

vi.mock("next/navigation", () => ({ useParams: () => ({ orgSlug: "acme" }) }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mockToastError(...args) },
}));

import ApiKeysPage from "./page";

const TOKEN = "pk_33333333-3333-4333-8333-333333333333_" + "a".repeat(64);

function key(over: Record<string, unknown> = {}) {
  return {
    id: "k1",
    name: "ci",
    permissions: ["org:write"],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    ...over,
  };
}

describe("ApiKeysPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // `org:write` is Owner-only and the nav entry is offered to every role, so a
  // refusal is expected and must read as "not yours", not as an empty list.
  it("explains a 403 instead of showing an error or an empty list", async () => {
    mockList.mockRejectedValue(new ApiError(403, "Missing permission: org:write"));

    render(<ApiKeysPage />);

    await waitFor(() => expect(screen.getByText("permission.required.title")).toBeInTheDocument());
    expect(screen.getByText("permission.required.apiKeys")).toBeInTheDocument();
    expect(screen.queryByText("apiKeys.empty.title")).not.toBeInTheDocument();
    expect(screen.queryByText("apiKeys.create.button")).not.toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("lists keys with their usage and expiry state", async () => {
    mockList.mockResolvedValue({
      keys: [
        key({ id: "k1", name: "ci" }),
        key({ id: "k2", name: "old laptop", expiresAt: "2001-01-01T00:00:00.000Z" }),
      ],
    });

    render(<ApiKeysPage />);

    const ciRow = (await screen.findByText("ci")).closest("tr")!;
    expect(within(ciRow).getByText("apiKeys.neverUsed")).toBeInTheDocument();
    expect(within(ciRow).getByText("apiKeys.noExpiry")).toBeInTheDocument();
    const oldRow = screen.getByText("old laptop").closest("tr")!;
    expect(within(oldRow).getByText("apiKeys.expired")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith("acme");
  });

  it("creates a key and shows its token once, gone after the dialog closes", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValueOnce({ keys: [] }).mockResolvedValue({ keys: [key()] });
    mockCreate.mockResolvedValue({ key: key(), token: TOKEN });

    render(<ApiKeysPage />);

    await user.click(await screen.findByRole("button", { name: "apiKeys.create.button" }));
    await user.type(screen.getByLabelText("apiKeys.create.nameLabel"), "  ci  ");
    await user.click(screen.getByRole("button", { name: "apiKeys.create.submit" }));

    expect(await screen.findByText(TOKEN)).toBeInTheDocument();
    expect(screen.getByText("apiKeys.created.shownOnce")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "apiKeys.created.copy" })).toBeInTheDocument();
    // No expiry chosen: the field is left out rather than sent empty.
    expect(mockCreate).toHaveBeenCalledWith("acme", { name: "ci" });
    // The list behind the dialog already shows the new key.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "apiKeys.created.done" }));
    await waitFor(() => expect(screen.queryByText(TOKEN)).not.toBeInTheDocument());
  });

  it("sends a chosen expiry as the end of that day", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ keys: [] });
    mockCreate.mockResolvedValue({ key: key(), token: TOKEN });

    render(<ApiKeysPage />);

    await user.click(await screen.findByRole("button", { name: "apiKeys.create.button" }));
    await user.type(screen.getByLabelText("apiKeys.create.nameLabel"), "ci");
    await user.type(screen.getByLabelText("apiKeys.create.expiryLabel"), "2099-03-15");
    await user.click(screen.getByRole("button", { name: "apiKeys.create.submit" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const sent = new Date(mockCreate.mock.calls[0][1].expiresAt);
    expect([sent.getFullYear(), sent.getMonth(), sent.getDate(), sent.getHours()]).toEqual([
      2099, 2, 15, 23,
    ]);
  });

  it("revokes a key only after confirmation", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValueOnce({ keys: [key({ id: "k1", name: "ci" })] }).mockResolvedValue({ keys: [] });
    mockRemove.mockResolvedValue({ deleted: true });

    render(<ApiKeysPage />);

    await user.click(await screen.findByRole("button", { name: "apiKeys.revoke.button" }));
    expect(mockRemove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "apiKeys.revoke.confirm" }));

    expect(mockRemove).toHaveBeenCalledWith("acme", "k1");
    await waitFor(() => expect(screen.queryByText("ci")).not.toBeInTheDocument());
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("takes the revoked key off the screen before the new list arrives", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValueOnce({ keys: [key({ id: "k1", name: "ci" })] }).mockReturnValue(new Promise(() => {}));
    mockRemove.mockResolvedValue({ deleted: true });

    render(<ApiKeysPage />);

    await user.click(await screen.findByRole("button", { name: "apiKeys.revoke.button" }));
    await user.click(screen.getByRole("button", { name: "apiKeys.revoke.confirm" }));

    await waitFor(() => expect(screen.queryByText("ci")).not.toBeInTheDocument());
  });

  it("reads the list once however often the page re-renders", async () => {
    mockList.mockResolvedValue({ keys: [key()] });
    const { rerender } = render(<ApiKeysPage />);
    await screen.findByText("ci");
    rerender(<ApiKeysPage />);
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("states a failed load with a retry, apart from a refusal", async () => {
    const user = userEvent.setup();
    mockList.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ keys: [key()] });
    render(<ApiKeysPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("apiKeys.loadFailed");
    await user.click(screen.getByRole("button", { name: "common.retry" }));
    expect(await screen.findByText("ci")).toBeInTheDocument();
  });
});
