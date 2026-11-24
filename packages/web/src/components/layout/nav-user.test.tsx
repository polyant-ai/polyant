// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavUser } from "./nav-user";

const { mockSignOut, mockSetLocale, mockSetTheme } = vi.hoisted(() => ({
  mockSignOut: vi.fn(),
  mockSetLocale: vi.fn(),
  mockSetTheme: vi.fn(),
}));

vi.mock("next-auth/react", () => ({ signOut: (...args: unknown[]) => mockSignOut(...args) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: mockSetTheme }) }));
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "it", setLocale: mockSetLocale }),
}));
vi.mock("@/components/auth/change-password-form", () => ({ ChangePasswordForm: () => null }));

describe("NavUser", () => {
  // The break this catches: the user menu living in the sidebar footer instead of the header,
  // or losing the way out.
  it("opens a menu with the name, the email and a way out", async () => {
    render(<NavUser user={{ name: "Ada Lovelace", email: "ada@example.com" }} />);

    // The initials are decorative: the visible text must not contradict the button's name.
    const trigger = screen.getByRole("button", { name: "user.menu" });
    expect(within(trigger).getByText("AL").closest("[aria-hidden=true]")).not.toBeNull();
    await userEvent.click(trigger);

    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "user.logout" }));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });

  // The break this catches: language and theme left the header for this menu, so losing
  // them here leaves no way to change either.
  it("changes the language and the theme from submenus that show the current value", async () => {
    const user = userEvent.setup();
    render(<NavUser user={{ name: "Ada Lovelace", email: "ada@example.com" }} />);
    await user.click(screen.getByRole("button", { name: "user.menu" }));

    const language = screen.getByRole("menuitem", { name: /common\.language/ });
    expect(language).toHaveTextContent("Italiano");
    // Radix opens a submenu from the keyboard in jsdom; pointer hover needs layout.
    act(() => language.focus());
    await user.keyboard("{ArrowRight}");
    const english = await screen.findByRole("menuitemradio", { name: "English" });
    act(() => english.focus());
    await user.keyboard("{Enter}");
    expect(mockSetLocale).toHaveBeenCalledWith("en");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "user.menu" }));
    const theme = screen.getByRole("menuitem", { name: /common\.theme/ });
    expect(theme).toHaveTextContent("common.themeLight");
    act(() => theme.focus());
    await user.keyboard("{ArrowRight}");
    const dark = await screen.findByRole("menuitemradio", { name: "common.themeDark" });
    act(() => dark.focus());
    await user.keyboard("{Enter}");
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
