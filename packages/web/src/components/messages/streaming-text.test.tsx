// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StreamingText } from "./streaming-text";

describe("StreamingText", () => {
  it("fades in only the words that arrive, keeping the ones already shown", () => {
    const { container, rerender } = render(<p><StreamingText text="Buongiorno, ho" /></p>);
    const first = container.querySelectorAll(".stream-word")[0];

    rerender(<p><StreamingText text="Buongiorno, ho trovato il suo" /></p>);
    const words = container.querySelectorAll(".stream-word");
    expect([...words].map((w) => w.textContent)).toEqual(["Buongiorno,", "ho", "trovato", "il", "suo"]);
    expect(words[0]).toBe(first);
    expect(container.textContent).toBe("Buongiorno, ho trovato il suo");
  });
});
