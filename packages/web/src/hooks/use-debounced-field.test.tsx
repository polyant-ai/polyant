// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { useDebouncedField } from "./use-debounced-field";

/** A field over an owner that stores what is committed, as a page's state does. */
function mountField(initial: string, delayMs: number, onCommit: (next: string) => void) {
  return renderHook(
    ({ value }) => useDebouncedField(value, onCommit, delayMs),
    { initialProps: { value: initial } },
  );
}

describe("useDebouncedField", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows each keystroke at once and commits once typing pauses", () => {
    const onCommit = vi.fn();
    const { result } = mountField("", 300, onCommit);

    act(() => result.current[1]("a"));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current[1]("ab"));
    expect(result.current[0]).toBe("ab");
    act(() => vi.advanceTimersByTime(299));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("ab");
  });

  it("commits nothing on mount, nor for an edit typed back to the committed text", () => {
    const onCommit = vi.fn();
    const { result } = mountField("acme", 300, onCommit);

    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current[1]("acm"));
    act(() => result.current[1]("acme"));
    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("takes a text changed elsewhere while no edit is waiting", () => {
    const { result, rerender } = mountField("acme", 300, vi.fn());

    rerender({ value: "" });
    expect(result.current[0]).toBe("");
  });

  it("keeps what was typed while the previous commit is still on its way back", () => {
    const onCommit = vi.fn();
    const { result, rerender } = mountField("", 300, onCommit);

    act(() => result.current[1]("ab"));
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current[1]("abc"));
    // The owner passes the first commit back only now.
    rerender({ value: "ab" });
    expect(result.current[0]).toBe("abc");
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenLastCalledWith("abc");
  });

  it("commits through the latest callback, not the one of the render that started the wait", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { result, rerender } = renderHook(
      ({ onCommit }) => useDebouncedField("", onCommit, 300),
      { initialProps: { onCommit: first } },
    );

    act(() => result.current[1]("a"));
    rerender({ onCommit: latest });
    act(() => vi.advanceTimersByTime(300));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith("a");
  });
});
