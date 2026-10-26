// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders, userEvent } from "@/test-utils";
import { ApiError } from "@/lib/api";
import { toast } from "sonner";
import { CreateUserSheet } from "./create-user-sheet";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
// A made-up one-time value the drawer shows once; not a credential.
const ONE_TIME_SECRET = "Gen-Pass-42";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { users: { create: mockCreate } } };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  renderWithProviders(
    <CreateUserSheet open onOpenChange={onOpenChange} onCreated={onCreated} />,
  );
  return { onOpenChange, onCreated };
}

describe("CreateUserSheet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cannot be submitted without an email", async () => {
    const u = userEvent.setup();
    renderDialog();

    const submit = screen.getByRole("button", { name: "Aggiungi" });
    expect(submit).toBeDisabled();

    await u.type(screen.getByLabelText("Email"), "   ");
    expect(submit).toBeDisabled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("sends trimmed values, leaves a blank password out, and closes", async () => {
    const u = userEvent.setup();
    mockCreate.mockResolvedValue({ user: { id: "u-1" } });
    const { onOpenChange, onCreated } = renderDialog();

    await u.type(screen.getByLabelText("Email"), "ada@example.com");
    await u.type(screen.getByLabelText("Nome (opzionale)"), "  Ada Lovelace ");
    await u.click(screen.getByRole("switch", { name: "Platform Admin" }));
    await u.type(screen.getByLabelText("Password (opzionale)"), "   ");
    await u.click(screen.getByRole("button", { name: "Aggiungi" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockCreate).toHaveBeenCalledWith({
      email: "ada@example.com",
      name: "Ada Lovelace",
      isPlatformAdmin: true,
      password: undefined,
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("shows a generated password once instead of closing", async () => {
    const u = userEvent.setup();
    mockCreate.mockResolvedValue({ user: { id: "u-1" }, generatedPassword: ONE_TIME_SECRET });
    const { onOpenChange } = renderDialog();

    await u.type(screen.getByLabelText("Email"), "ada@example.com");
    await u.click(screen.getByRole("button", { name: "Aggiungi" }));

    expect(await screen.findByText("Gen-Pass-42")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    // A generated password is shown, not edited: the footer is a single Close.
    expect(screen.queryByRole("button", { name: "Annulla" })).not.toBeInTheDocument();
    await u.click(screen.getAllByRole("button", { name: "Chiudi" })[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reports a failure and keeps the form open", async () => {
    const u = userEvent.setup();
    mockCreate.mockRejectedValue(new ApiError(409, "Email already in use"));
    const { onOpenChange, onCreated } = renderDialog();

    await u.type(screen.getByLabelText("Email"), "ada@example.com");
    await u.click(screen.getByRole("button", { name: "Aggiungi" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Email already in use"));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
  });
});
