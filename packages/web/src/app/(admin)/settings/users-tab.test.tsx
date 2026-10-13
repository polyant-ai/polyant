// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders, userEvent } from "@/test-utils";
import type { AdminUser } from "@/lib/api";
import { UsersTab } from "./users-tab";

const { mockList, mockDelete, mockReset, mockUpdate } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockDelete: vi.fn(),
  mockReset: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      users: {
        list: mockList,
        delete: mockDelete,
        resetPassword: mockReset,
        update: mockUpdate,
        create: vi.fn(),
      },
    },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "me" } }, status: "authenticated" }),
}));

function user(over: Partial<AdminUser>): AdminUser {
  return {
    id: "u-1",
    email: "user@example.com",
    name: null,
    image: null,
    isPlatformAdmin: false,
    mustChangePassword: false,
    hasPassword: true,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}

const ME = user({ id: "me", email: "me@example.com", isPlatformAdmin: true });
const ADA = user({ id: "u-ada", email: "ada@example.com", name: "Ada" });
const BOB = user({ id: "u-bob", email: "bob@example.com" });
// A made-up one-time value the dialog shows once; not a credential.
const ONE_TIME_SECRET = "Temp-Pass-123";

async function renderTab() {
  renderWithProviders(<UsersTab />);
  await screen.findByText("ada@example.com");
}

function rowOf(email: string): HTMLElement {
  return screen.getByText(email).closest("tr") as HTMLElement;
}

describe("UsersTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ users: [ME, ADA, BOB], total: 3 });
  });

  it("lists every account with its role", async () => {
    await renderTab();

    expect(within(rowOf("me@example.com")).getByText("Platform Admin")).toBeInTheDocument();
    expect(within(rowOf("ada@example.com")).getByText("Utente")).toBeInTheDocument();
    expect(within(rowOf("ada@example.com")).getByText("Ada")).toBeInTheDocument();
  });

  it("does not let the signed-in admin delete their own account", async () => {
    await renderTab();

    expect(within(rowOf("me@example.com")).getByRole("button", { name: "Elimina" })).toBeDisabled();
    expect(within(rowOf("ada@example.com")).getByRole("button", { name: "Elimina" })).toBeEnabled();
  });

  it("deletes nothing until the deletion is confirmed, and nothing on cancel", async () => {
    const u = userEvent.setup();
    await renderTab();

    await u.click(within(rowOf("ada@example.com")).getByRole("button", { name: "Elimina" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("ada@example.com")).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();

    await u.click(within(dialog).getByRole("button", { name: "Annulla" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes the account named in the confirmation and reloads the list", async () => {
    const u = userEvent.setup();
    mockDelete.mockResolvedValue({ deleted: true });
    await renderTab();

    await u.click(within(rowOf("bob@example.com")).getByRole("button", { name: "Elimina" }));
    const dialog = await screen.findByRole("alertdialog");
    mockList.mockResolvedValue({ users: [ME, ADA], total: 2 });
    await u.click(within(dialog).getByRole("button", { name: "Elimina" }));

    await waitFor(() => expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument());
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("u-bob");
  });

  it("resets a password only on confirmation and shows the temporary one", async () => {
    const u = userEvent.setup();
    mockReset.mockResolvedValue({ user: ADA, generatedPassword: ONE_TIME_SECRET });
    await renderTab();

    await u.click(within(rowOf("ada@example.com")).getByRole("button", { name: "Reset password" }));
    const dialog = await screen.findByRole("dialog");
    expect(mockReset).not.toHaveBeenCalled();
    expect(within(dialog).queryByText("Temp-Pass-123")).not.toBeInTheDocument();

    await u.click(within(dialog).getByRole("button", { name: "Genera nuova password" }));

    expect(await within(dialog).findByText("Temp-Pass-123")).toBeInTheDocument();
    expect(mockReset).toHaveBeenCalledWith("u-ada");
  });

  it("does not show the temporary password again once the dialog is closed", async () => {
    const u = userEvent.setup();
    mockReset.mockResolvedValue({ user: ADA, generatedPassword: ONE_TIME_SECRET });
    await renderTab();

    await u.click(within(rowOf("ada@example.com")).getByRole("button", { name: "Reset password" }));
    await u.click(await screen.findByRole("button", { name: "Genera nuova password" }));
    await screen.findByText("Temp-Pass-123");
    await u.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await u.click(within(rowOf("ada@example.com")).getByRole("button", { name: "Reset password" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Temp-Pass-123")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Genera nuova password" })).toBeInTheDocument();
  });

  it("cancelling a reset sends nothing", async () => {
    const u = userEvent.setup();
    await renderTab();

    await u.click(within(rowOf("ada@example.com")).getByRole("button", { name: "Reset password" }));
    await u.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Annulla" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("grants the platform-admin flag to the edited account", async () => {
    const u = userEvent.setup();
    mockUpdate.mockResolvedValue({ user: { ...ADA, isPlatformAdmin: true } });
    await renderTab();

    await u.click(within(rowOf("ada@example.com")).getByRole("button", { name: "Modifica" }));
    const dialog = await screen.findByRole("dialog");
    const flag = within(dialog).getByRole("switch", { name: "Platform Admin" });
    expect(flag).toHaveAttribute("aria-checked", "false");
    await u.click(flag);
    await u.clear(within(dialog).getByLabelText("Nome (opzionale)"));
    await u.click(within(dialog).getByRole("button", { name: "Salva modifiche" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // An emptied name is sent as null so the engine clears it.
    expect(mockUpdate).toHaveBeenCalledWith("u-ada", { name: null, isPlatformAdmin: true });
  });

  it("pages through accounts beyond the first page", async () => {
    const u = userEvent.setup();
    mockList.mockResolvedValue({ users: [ME, ADA, BOB], total: 30 });
    await renderTab();

    expect(screen.getByText("1-25 di 30")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Successiva" }));

    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ limit: 25, offset: 25 }));
  });
});
