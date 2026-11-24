// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chip } from "./chip";

describe("Chip", () => {
  it("is a non-submitting button by default", () => {
    render(<Chip>X</Chip>);
    expect(screen.getByRole("button", { name: "X" })).toHaveAttribute("type", "button");
  });
});
