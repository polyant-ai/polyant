// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownRenderer } from "./markdown-renderer";

describe("MarkdownRenderer while streaming", () => {
  it("keeps the words already shown as the same nodes while the reply grows", () => {
    const { container, rerender } = render(<MarkdownRenderer streaming content={"Tre orari:\n\n- **14:30** con"} />);
    const shown = [...container.querySelectorAll(".stream-word")];

    rerender(<MarkdownRenderer streaming content={"Tre orari:\n\n- **14:30** con la dottoressa\n- 15:45"} />);
    const now = [...container.querySelectorAll(".stream-word")];
    // A node rebuilt on every chunk replays its fade: the whole message blinks.
    expect(shown.every((node, i) => now[i] === node)).toBe(true);
    expect(now.length).toBeGreaterThan(shown.length);
  });
});
