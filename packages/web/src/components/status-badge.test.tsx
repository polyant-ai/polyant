// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./status-badge";

/** The classes a Badge of the given variant carries, as the one source of what each looks like. */
function classesOf(variant: "default" | "secondary" | "destructive") {
  const { unmount, container } = render(<Badge variant={variant}>x</Badge>);
  const classes = container.firstElementChild!.className;
  unmount();
  return classes;
}

describe("StatusBadge", () => {
  it("draws a good state as the default badge, a neutral one as secondary and a failure as destructive", () => {
    render(
      <>
        <StatusBadge tone="positive">Ready</StatusBadge>
        <StatusBadge tone="neutral">Paused</StatusBadge>
        <StatusBadge tone="negative">Failed</StatusBadge>
      </>,
    );
    expect(screen.getByText("Ready").className).toBe(classesOf("default"));
    expect(screen.getByText("Paused").className).toBe(classesOf("secondary"));
    expect(screen.getByText("Failed").className).toBe(classesOf("destructive"));
  });

  it("puts no icon inside the pill", () => {
    render(<StatusBadge tone="positive">Ready</StatusBadge>);
    expect(screen.getByText("Ready").querySelector("svg")).toBeNull();
  });
});
