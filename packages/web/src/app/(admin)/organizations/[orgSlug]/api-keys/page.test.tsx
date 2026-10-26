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

  it("creates a key and shows its token once, gone after the drawer closes", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValueOnce({ keys: [] }).mockResolvedValue({ keys: [key()] });
    mockCreate.mockResolvedValue({ key: key(), token: TOKEN });

    render(<ApiKeysPage />);

    await user.click(await screen.findByRole("button", { name: "apiKeys.create.button" }));
    await user.type(screen.getByLabelText("apiKeys.create.nameLabel"), "  ci  ");
    await user.click(screen.getByRole("button", { name: "common.add" }));

    expect(await screen.findByText(TOKEN)).toBeInTheDocument();
    expect(screen.getByText("apiKeys.created.shownOnce")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "apiKeys.created.copy" })).toBeInTheDocument();
    // No expiry chosen: the field is left out rather than sent empty.
    expect(mockCreate).toHaveBeenCalledWith("acme", { name: "ci" });
    // The list behind the drawer already shows the new key.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));

    await user.click(screen.getAllByRole("button", { name: "common.close" })[0]);
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
    await user.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const sent = new Date(mockCreate.mock.calls[0][1].expiresAt);
    expect([sent.getFullYear(), sent.getMonth(), sent.getDate(), sent.getHours()]).toEqual([
      2099, 2, 15, 23,
    ]);
  });

  it("filters the keys on name and expiry as typed", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      keys: [key({ id: "k1", name: "ci" }), key({ id: "k2", name: "old laptop", expiresAt: "2001-01-01T00:00:00.000Z" })],
    });
    render(<ApiKeysPage />);
    await screen.findByText("ci");
    const search = screen.getByRole("searchbox", { name: "common.search" });

    await user.type(search, "laptop");
    expect(screen.getByText("old laptop")).toBeInTheDocument();
    expect(screen.queryByText("ci")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "apiKeys.noExpiry");
    expect(screen.getByText("ci")).toBeInTheDocument();
    expect(screen.queryByText("old laptop")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("common.noResults")).toBeInTheDocument();
  });

  it("opens a drawer with the key's details when its row is clicked, and offers no revoke on the row", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ keys: [key({ id: "k1", name: "ci" })] });
    render(<ApiKeysPage />);

    const row = (await screen.findByText("ci")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "apiKeys.revoke.button" })).not.toBeInTheDocument();
    await user.click(row);

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "ci" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "apiKeys.revoke.button" })).toBeInTheDocument();
  });

  it("revokes a key only from the drawer and only after confirmation", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValueOnce({ keys: [key({ id: "k1", name: "ci" })] }).mockResolvedValue({ keys: [] });
    mockRemove.mockResolvedValue({ deleted: true });

    render(<ApiKeysPage />);

    await user.click((await screen.findByText("ci")).closest("tr")!);
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "apiKeys.revoke.button" }));
    expect(mockRemove).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "apiKeys.revoke.confirm" }));

    expect(mockRemove).toHaveBeenCalledWith("acme", "k1");
    await waitFor(() => expect(screen.queryByText("ci")).not.toBeInTheDocument());
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("revokes nothing when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ keys: [key({ id: "k1", name: "ci" })] });
    render(<ApiKeysPage />);

    await user.click((await screen.findByText("ci")).closest("tr")!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "apiKeys.revoke.button" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "common.cancel" }));
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("takes the revoked key off the screen before the new list arrives", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValueOnce({ keys: [key({ id: "k1", name: "ci" })] }).mockReturnValue(new Promise(() => {}));
    mockRemove.mockResolvedValue({ deleted: true });

    render(<ApiKeysPage />);

    await user.click((await screen.findByText("ci")).closest("tr")!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "apiKeys.revoke.button" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "apiKeys.revoke.confirm" }));

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

  it("lists the keys alphabetically by name", async () => {
    mockList.mockResolvedValue({ keys: [key({ id: "k1", name: "zeta" }), key({ id: "k2", name: "alpha" })] });
    render(<ApiKeysPage />);
    await screen.findByText("zeta");
    const names = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("button")[0].textContent);
    expect(names).toEqual(["alpha", "zeta"]);
  });

  it("gives the key's drawer a description line with its creation date, and a Close only footer besides Revoke", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ keys: [key({ id: "k1", name: "ci" })] });
    render(<ApiKeysPage />);
    await user.click((await screen.findByText("ci")).closest("tr")!);
    const drawer = await screen.findByRole("dialog");
    expect(drawer.querySelector("[data-slot=sheet-description]")).toHaveTextContent("apiKeys.drawer.createdOn");
    const footer = drawer.querySelector("[data-slot=sheet-footer]") as HTMLElement;
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(["apiKeys.revoke.button", "common.close"]);
  });
});
