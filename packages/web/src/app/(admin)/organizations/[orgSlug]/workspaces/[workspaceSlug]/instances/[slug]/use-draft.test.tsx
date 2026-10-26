// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { useDraft } from "./use-draft";

describe("useDraft", () => {
  it("starts clean and shows the baseline", () => {
    const { result } = renderHook(() => useDraft({ name: "a", on: false }));
    expect(result.current.draft).toEqual({ name: "a", on: false });
    expect(result.current.isDirty).toBe(false);
  });

  it("is dirty while a field differs and clean again when it is put back", () => {
    const { result } = renderHook(() => useDraft({ name: "a", tags: ["x"] }));
    act(() => result.current.set("name", "b"));
    expect(result.current.draft.name).toBe("b");
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.set("name", "a"));
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.set("tags", ["x", "y"]));
    expect(result.current.isDirty).toBe(true);
  });

  it("drops the edits when the baseline changes, so a saved form is clean", () => {
    const { result, rerender } = renderHook(({ base }) => useDraft(base), { initialProps: { base: { name: "a" } } });
    act(() => result.current.set("name", "b"));
    rerender({ base: { name: "b" } });
    expect(result.current.draft.name).toBe("b");
    expect(result.current.isDirty).toBe(false);
  });

  it("does not drop the edits when a new but equal baseline object arrives", () => {
    const { result, rerender } = renderHook(({ base }) => useDraft(base), { initialProps: { base: { name: "a" } } });
    act(() => result.current.set("name", "b"));
    rerender({ base: { name: "a" } });
    expect(result.current.draft.name).toBe("b");
    expect(result.current.isDirty).toBe(true);
  });

  it("does not bring dropped edits back when the baseline returns to a former value", () => {
    const { result, rerender } = renderHook(({ base }) => useDraft(base), { initialProps: { base: { name: "a" } } });
    act(() => result.current.set("name", "x"));
    rerender({ base: { name: "b" } });
    rerender({ base: { name: "a" } });
    expect(result.current.draft.name).toBe("a");
    expect(result.current.isDirty).toBe(false);
  });
});
