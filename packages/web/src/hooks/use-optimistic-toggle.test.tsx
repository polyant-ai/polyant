// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { useOptimisticToggle } from "./use-optimistic-toggle";

describe("useOptimisticToggle", () => {
  it("shows the chosen position at once and keeps it after the engine accepts", async () => {
    const rows = [{ id: "a" }];
    const { result } = renderHook(() => useOptimisticToggle(rows, "acme/sales"));
    let finish!: () => void;
    const commit = () => new Promise<void>((resolve) => (finish = resolve));

    let done!: Promise<void>;
    act(() => {
      done = result.current.toggle("a", true, commit, vi.fn());
    });
    expect(result.current.value("a", false)).toBe(true);

    await act(async () => {
      finish();
      await done;
    });
    expect(result.current.value("a", false)).toBe(true);
  });

  it("takes the position back and reports the error when the engine refuses", async () => {
    const rows = [{ id: "a" }];
    const onError = vi.fn();
    const { result } = renderHook(() => useOptimisticToggle(rows, "acme/sales"));

    await act(async () => {
      await result.current.toggle("a", true, () => Promise.reject(new Error("no")), onError);
    });

    expect(result.current.value("a", false)).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("drops the choices when the rows are read again", async () => {
    const { result, rerender } = renderHook(({ rows }) => useOptimisticToggle(rows, "acme/sales"), {
      initialProps: { rows: [{ id: "a" }] },
    });
    await act(async () => {
      await result.current.toggle("a", true, () => Promise.resolve(), vi.fn());
    });

    rerender({ rows: [{ id: "a" }] });

    expect(result.current.value("a", false)).toBe(false);
  });

  it("says nothing about a failure that arrives after the reader changed scope", async () => {
    const onError = vi.fn();
    const rows = [{ id: "a" }];
    const { result, rerender } = renderHook(({ scope }) => useOptimisticToggle(rows, scope), {
      initialProps: { scope: "acme/sales" },
    });
    let fail!: (err: Error) => void;
    let done!: Promise<void>;
    act(() => {
      done = result.current.toggle("a", true, () => new Promise((_, reject) => (fail = reject)), onError);
    });

    rerender({ scope: "acme/support" });
    await act(async () => {
      fail(new Error("no"));
      await done;
    });

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.value("a", false)).toBe(false);
  });

  it("after a success then a refusal, shows the position the engine holds", async () => {
    const rows = [{ id: "a" }];
    const { result } = renderHook(() => useOptimisticToggle(rows, "acme/sales"));
    await act(async () => {
      await result.current.toggle("a", true, () => Promise.resolve(), vi.fn());
    });
    expect(result.current.value("a", false)).toBe(true);
    await act(async () => {
      await result.current.toggle("a", false, () => Promise.reject(new Error("no")), vi.fn());
    });
    expect(result.current.value("a", false)).toBe(true);
  });

  it("after a revoke then a refused re-assign, shows the revoked position", async () => {
    const rows = [{ id: "a" }];
    const { result } = renderHook(() => useOptimisticToggle(rows, "acme/sales"));
    await act(async () => {
      await result.current.toggle("a", false, () => Promise.resolve(), vi.fn());
    });
    await act(async () => {
      await result.current.toggle("a", true, () => Promise.reject(new Error("no")), vi.fn());
    });
    expect(result.current.value("a", true)).toBe(false);
  });
});
