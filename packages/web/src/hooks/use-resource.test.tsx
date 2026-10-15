// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useResource } from "./use-resource";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useResource", () => {
  it("loads, then reloads without dropping the data", async () => {
    let n = 0;
    const { result } = renderHook(() => useResource("k", async () => ++n));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(1));
    expect(result.current.loading).toBe(false);
    act(() => result.current.reload());
    expect(result.current.data).toBe(1);
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it("ignores an answer that arrives for an old key", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(({ k }) => useResource(k, () => (k === "a" ? first.promise : second.promise)), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await act(async () => second.resolve("B"));
    await act(async () => first.resolve("A"));
    expect(result.current.data).toBe("B");
  });

  it("reports a failure and clears it on reload", async () => {
    let fail = true;
    const { result } = renderHook(() => useResource("k", async () => { if (fail) throw new Error("x"); return 1; }));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe(1));
    expect(result.current.error).toBeUndefined();
  });

  it("does nothing for a null key", () => {
    let called = false;
    const { result } = renderHook(() => useResource(null, async () => { called = true; return 1; }));
    expect(called).toBe(false);
    expect(result.current.loading).toBe(false);
  });
});
