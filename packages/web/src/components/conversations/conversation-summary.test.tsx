// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen } from "@testing-library/react";
import { renderWithProviders, userEvent } from "@/test-utils";
import { ConversationSummary } from "./conversation-summary";

/** jsdom lays nothing out, so the clamped paragraph's two heights are set by hand. */
function layout(scrollHeight: number, clientHeight: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(clientHeight);
}

describe("ConversationSummary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a short description whole, with no toggle", () => {
    layout(40, 40);
    renderWithProviders(<ConversationSummary summary="Richiesta di preventivo" />);
    expect(screen.getByText("Richiesta di preventivo")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clamps a long description to two lines and expands and collapses it", async () => {
    layout(120, 40);
    renderWithProviders(<ConversationSummary summary="Una descrizione lunga" />);
    expect(screen.getByRole("button", { name: "Mostra di più" })).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(screen.getByRole("button", { name: "Mostra di più" }));
    expect(screen.getByRole("button", { name: "Nascondi" })).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("button", { name: "Nascondi" }));
    expect(screen.getByRole("button", { name: "Mostra di più" })).toHaveAttribute("aria-expanded", "false");
  });
});
