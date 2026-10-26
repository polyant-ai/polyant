// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/context";
import RootNotFound from "./not-found";
import AdminNotFound from "./(admin)/not-found";

describe("root not-found", () => {
  it("is the same localized page the admin group shows, with a way home", () => {
    // An address that matches no route used to get Next's English default page; this
    // catches the root boundary falling back to it (or diverging from the admin one).
    expect(RootNotFound).toBe(AdminNotFound);
    render(
      <I18nProvider initialLocale="en">
        <RootNotFound />
      </I18nProvider>,
    );
    expect(screen.getByRole("heading", { name: "This page does not exist" })).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/");
  });
});
