// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistedState } from "./use-persisted-state";

const parseMode = (raw: string) => (raw === "grid" || raw === "list" ? raw : undefined);

describe("usePersistedState", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts from the initial value, then adopts a stored one after mount", async () => {
    window.localStorage.setItem("view", "list");
    const { result } = renderHook(() => usePersistedState<"grid" | "list">("view", "grid", parseMode));
    await waitFor(() => expect(result.current[0]).toBe("list"));
  });

  it("ignores a stored value the parser rejects", async () => {
    window.localStorage.setItem("view", "table");
    const { result } = renderHook(() => usePersistedState<"grid" | "list">("view", "grid", parseMode));
    await Promise.resolve();
    expect(result.current[0]).toBe("grid");
  });

  it("stores what is set, and keeps working when storage throws", () => {
    const { result } = renderHook(() => usePersistedState<"grid" | "list">("view", "grid", parseMode));
    act(() => result.current[1]("list"));
    expect(window.localStorage.getItem("view")).toBe("list");

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => result.current[1]("grid"));
    expect(result.current[0]).toBe("grid");
    vi.restoreAllMocks();
  });
});
