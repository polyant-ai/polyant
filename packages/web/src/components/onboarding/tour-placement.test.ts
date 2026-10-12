// SPDX-License-Identifier: AGPL-3.0-or-later

import { placeBubble } from "./tour-overlay";

const viewport = { w: 1000, h: 700 };
const size = { w: 340, h: 180 };
const box = { x1: 400, y1: 300, x2: 600, y2: 360 };

describe("bubble placement", () => {
  it("uses the preferred side when it fits", () => {
    expect(placeBubble(box, size, viewport, "bottom", false).side).toBe("bottom");
    expect(placeBubble(box, size, viewport, "right", false).side).toBe("right");
  });

  it("falls back when the preferred side has no room", () => {
    const low = { x1: 400, y1: 600, x2: 600, y2: 660 };
    expect(placeBubble(low, size, viewport, "bottom", false).side).toBe("top");
  });

  it("stays inside the viewport at the edges", () => {
    const edge = { x1: 0, y1: 300, x2: 40, y2: 360 };
    const at = placeBubble(edge, size, viewport, "bottom", false);
    expect(at.x).toBeGreaterThanOrEqual(16);
    expect(at.x + size.w).toBeLessThanOrEqual(viewport.w - 16);
  });

  it("only uses above or below on a narrow screen", () => {
    expect(placeBubble(box, size, { w: 390, h: 700 }, "right", true).side).toMatch(/top|bottom/);
  });

  it("centres the bubble when there is no element", () => {
    const at = placeBubble(null, size, viewport, "bottom", false);
    expect(at.side).toBeNull();
    expect(at.x).toBe((viewport.w - size.w) / 2);
  });
});
