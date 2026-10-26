// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderHook } from "@testing-library/react";

const mockToastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }));

import { useReloadFailureToast } from "./use-reload-failure-toast";

describe("useReloadFailureToast", () => {
  beforeEach(() => mockToastError.mockClear());

  it("says nothing without a failure", () => {
    renderHook(() => useReloadFailureToast(undefined, true, "failed"));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("says nothing while there is no data to be stale (the page shows its own failure state)", () => {
    renderHook(() => useReloadFailureToast(new Error("x"), false, "failed"));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("says so once when a reload fails over held data", () => {
    const error = new Error("x");
    const { rerender } = renderHook(({ e }) => useReloadFailureToast(e, true, "failed"), { initialProps: { e: undefined as unknown } });
    rerender({ e: error });
    rerender({ e: error });
    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("failed");
  });
});
