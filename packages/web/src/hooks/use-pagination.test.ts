// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { usePagination } from "./use-pagination";

describe("usePagination", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a page chosen before the first debounce interval has passed", () => {
    const { result } = renderHook(() => usePagination({ debounceMs: 400 }));
    act(() => result.current.setPage(2));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.page).toBe(2);
  });

  it("returns to page 1 when the search changes", () => {
    const { result } = renderHook(() => usePagination({ debounceMs: 400 }));
    act(() => result.current.setPage(3));
    act(() => result.current.setSearch("acme"));
    act(() => vi.advanceTimersByTime(400));
    expect(result.current.page).toBe(1);
    expect(result.current.debouncedSearch).toBe("acme");
  });
});
