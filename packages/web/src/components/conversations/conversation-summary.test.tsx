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
    expect(screen.getByText("Richiesta di preventivo")).toHaveClass("line-clamp-2");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clamps a long description to two lines and expands and collapses it", async () => {
    layout(120, 40);
    renderWithProviders(<ConversationSummary summary="Una descrizione lunga" />);
    const text = screen.getByText("Una descrizione lunga");

    await userEvent.click(screen.getByRole("button", { name: "Mostra di più" }));
    expect(text).not.toHaveClass("line-clamp-2");

    await userEvent.click(screen.getByRole("button", { name: "Nascondi" }));
    expect(text).toHaveClass("line-clamp-2");
  });
});
