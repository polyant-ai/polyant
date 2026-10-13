// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chip } from "./chip";

describe("Chip", () => {
  it("styles the active chip as selected", () => {
    render(<Chip active>On</Chip>);
    expect(screen.getByRole("button", { name: "On" }).className).toContain("bg-primary");
  });

  it("styles the inactive chip as muted", () => {
    render(<Chip>Off</Chip>);
    const cls = screen.getByRole("button", { name: "Off" }).className;
    expect(cls).toContain("text-muted-foreground");
    expect(cls).not.toContain("bg-primary");
  });

  it("is a non-submitting button by default", () => {
    render(<Chip>X</Chip>);
    expect(screen.getByRole("button", { name: "X" })).toHaveAttribute("type", "button");
  });
});
