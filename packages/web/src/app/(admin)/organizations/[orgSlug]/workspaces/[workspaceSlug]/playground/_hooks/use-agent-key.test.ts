// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAccess } = vi.hoisted(() => ({ mockAccess: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { instances: { playgroundAccess: mockAccess } } }));

import { useAgentKey } from "./use-agent-key";

describe("useAgentKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("asks for no key from a user who can write the agent", async () => {
    mockAccess.mockResolvedValue({ keyRequired: false });
    const { result } = renderHook(() => useAgentKey("shop"));
    await waitFor(() => expect(mockAccess).toHaveBeenCalledWith("shop"));
    expect(result.current.keyRequired).toBe(false);
  });

  it("asks for the key from a user who can only read the agent", async () => {
    mockAccess.mockResolvedValue({ keyRequired: true });
    const { result } = renderHook(() => useAgentKey("shop"));
    await waitFor(() => expect(result.current.keyRequired).toBe(true));
  });

  it("keeps the field hidden when the engine does not answer", async () => {
    mockAccess.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useAgentKey("shop"));
    await waitFor(() => expect(mockAccess).toHaveBeenCalled());
    expect(result.current.keyRequired).toBe(false);
  });

  it("keeps the typed key per agent in localStorage, as the old playground did", async () => {
    mockAccess.mockResolvedValue({ keyRequired: true });
    const { result, rerender } = renderHook(({ slug }) => useAgentKey(slug), { initialProps: { slug: "shop" } });
    act(() => result.current.setKey("k-1"));
    expect(localStorage.getItem("playground_auth_shop")).toBe("k-1");

    rerender({ slug: "other" });
    await waitFor(() => expect(result.current.key).toBe(""));
    rerender({ slug: "shop" });
    await waitFor(() => expect(result.current.key).toBe("k-1"));

    act(() => result.current.setKey(""));
    expect(localStorage.getItem("playground_auth_shop")).toBeNull();
  });
});
