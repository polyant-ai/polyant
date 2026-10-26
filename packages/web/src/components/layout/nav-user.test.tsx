// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavUser } from "./nav-user";

const { mockSignOut } = vi.hoisted(() => ({ mockSignOut: vi.fn() }));

vi.mock("next-auth/react", () => ({ signOut: (...args: unknown[]) => mockSignOut(...args) }));
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/auth/change-password-form", () => ({ ChangePasswordForm: () => null }));

describe("NavUser", () => {
  // The break this catches: the user menu living in the sidebar footer instead of the header,
  // or losing the way out.
  it("opens a menu with the name, the email and a way out", async () => {
    render(<NavUser user={{ name: "Ada Lovelace", email: "ada@example.com" }} />);

    await userEvent.click(screen.getByRole("button", { name: "user.menu" }));

    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "user.logout" }));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });
});
