// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderToString } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { LoginFormClient } from "./login-form-client";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

// Before React hydrates, the form is the server's HTML and a click on its
// button is the browser's own submit: a GET to /login that reloads the page.
describe("LoginFormClient before and after hydration", () => {
  it("serves a form whose button cannot submit until React takes over", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<LoginFormClient />);

    const form = container.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it("enables the button once hydrated", () => {
    render(<LoginFormClient />);
    expect(screen.getByRole("button", { name: "login.signIn" })).toBeEnabled();
  });
});
