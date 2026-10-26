// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JsonTree } from "./json-tree";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));

describe("JsonTree", () => {
  const value = { customer: { name: "Ada", tags: ["vip"] }, confirmed: true, notes: null };

  it("shows the first level with its branches closed", () => {
    render(<JsonTree value={value} />);
    expect(screen.getByText("confirmed:")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("null")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "customer" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("name:")).not.toBeInTheDocument();
  });

  it("opens and closes one branch at a time with its toggle", async () => {
    render(<JsonTree value={value} />);
    await userEvent.click(screen.getByRole("button", { name: "customer" }));
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
    // The nested array stays closed until it is opened in turn.
    expect(screen.queryByText('"vip"')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "tags" }));
    expect(screen.getByText('"vip"')).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "customer" }));
    expect(screen.queryByText('"Ada"')).not.toBeInTheDocument();
  });

  it("opens a branch from its key, and shows no size beside it", async () => {
    render(<JsonTree value={value} />);
    expect(screen.queryByText("{2}")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("customer"));
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
  });

  it("copies a leaf value on click, a string without its quotes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<JsonTree value={{ city: "Torino", count: 3 }} />);

    await userEvent.click(screen.getByRole("button", { name: "common.copy city" }));
    expect(writeText).toHaveBeenCalledWith("Torino");
    expect(await screen.findByRole("button", { name: "common.copied city" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "common.copy count" }));
    expect(writeText).toHaveBeenLastCalledWith("3");
  });

  it("gives an empty branch no toggle", () => {
    render(<JsonTree value={{ empty: {}, list: [] }} />);
    expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
    expect(screen.getByText("{}")).toBeInTheDocument();
    expect(screen.getByText("[]")).toBeInTheDocument();
  });
});
