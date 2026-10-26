// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, userEvent } from "@/test-utils";
import { screen } from "@testing-library/react";
import { ConfirmDialog } from "./confirm-dialog";
import { Pager } from "./pager";

describe("ConfirmDialog", () => {
  it("runs onConfirm and marks the confirm button destructive", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmDialog open onOpenChange={() => {}} title="T" confirmLabel="Go" onConfirm={onConfirm} />);
    const go = screen.getByRole("button", { name: "Go" });
    expect(go.getAttribute("data-variant")).toBe("destructive");
    await userEvent.click(go);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("Pager", () => {
  it("steps pages and hides for a single page", async () => {
    const onPage = vi.fn();
    const { container, rerender } = renderWithProviders(<Pager page={2} totalPages={3} onPage={onPage} />);
    await userEvent.click(screen.getAllByRole("button")[1]);
    expect(onPage).toHaveBeenCalledWith(3);
    rerender(<Pager page={1} totalPages={1} onPage={onPage} />);
    expect(container.textContent).toBe("");
  });
});
