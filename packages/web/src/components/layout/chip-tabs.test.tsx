// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";

import { ChipTabs } from "./chip-tabs";

const tabs = [
  { value: "one", label: "One", children: <p>First</p> },
  { value: "two", label: "Two", children: <p>Second</p> },
];

describe("ChipTabs", () => {
  // `sticky` only works on an element taller pages scroll past: on the tablist
  // it is pinned inside a row exactly as tall as itself and never sticks.
  it("puts rowClassName on the row that holds the tablist and the actions", () => {
    render(<ChipTabs tabs={tabs} rowClassName="sticky top-0" actions={<button type="button">Act</button>} />);

    const row = screen.getByRole("tablist").parentElement;
    expect(row).toHaveClass("sticky", "top-0");
    expect(row).toContainElement(screen.getByRole("button", { name: "Act" }));
    expect(screen.getByRole("tablist")).not.toHaveClass("sticky");
  });
});
