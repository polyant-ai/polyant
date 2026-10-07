// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFollowBottom } from "./use-follow-bottom";

/** A scroll container whose content height the test sets. jsdom lays nothing out. */
function container(height: number, clientHeight = 500) {
  const el = document.createElement("div");
  let scrollHeight = height;
  Object.defineProperty(el, "clientHeight", { get: () => clientHeight });
  Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
  return {
    el,
    grow: (px: number) => {
      scrollHeight += px;
    },
    userScrollTo: (v: number) => {
      el.scrollTop = v;
      el.dispatchEvent(new Event("scroll"));
    },
  };
}

function render(c: ReturnType<typeof container>, active = true) {
  const ref = { current: c.el };
  return renderHook(({ active, content }) => useFollowBottom(ref, active, content), {
    initialProps: { active, content: 0 },
  });
}

describe("useFollowBottom", () => {
  it("follows content taller than the threshold while the reader is at the bottom", () => {
    const c = container(1000);
    const hook = render(c);
    expect(c.el.scrollTop).toBe(500);

    // A long reply: 800px at once, far more than the follow threshold.
    c.grow(800);
    hook.rerender({ active: true, content: 1 });
    expect(c.el.scrollTop).toBe(1300);
  });

  it("stays put once the reader scrolls up, and follows again back at the bottom", () => {
    const c = container(1000);
    const hook = render(c);
    act(() => c.userScrollTo(100));

    c.grow(300);
    hook.rerender({ active: true, content: 1 });
    expect(c.el.scrollTop).toBe(100);

    act(() => c.userScrollTo(800));
    c.grow(300);
    hook.rerender({ active: true, content: 2 });
    expect(c.el.scrollTop).toBe(1100);
  });

  it("keeps following when its own pin's scroll event lands after more content", () => {
    const c = container(1000);
    const hook = render(c);
    c.grow(400);
    hook.rerender({ active: true, content: 1 });
    // The pin's event arrives late, after another streamed chunk grew the page.
    c.grow(400);
    act(() => {
      c.el.dispatchEvent(new Event("scroll"));
    });
    hook.rerender({ active: true, content: 2 });
    expect(c.el.scrollTop).toBe(1300);
  });

  it("does nothing while inactive, and re-pins when turned on", () => {
    const c = container(1000);
    const hook = render(c, false);
    expect(c.el.scrollTop).toBe(0);
    act(() => c.userScrollTo(100));

    hook.rerender({ active: true, content: 0 });
    expect(c.el.scrollTop).toBe(500);
  });
});
