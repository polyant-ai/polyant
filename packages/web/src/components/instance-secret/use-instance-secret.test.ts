// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook, waitFor } from "@testing-library/react";
import { useInstanceSecret } from "./use-instance-secret";

const { mockList, mockSet, mockDelete } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockSet: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    secrets: {
      list: (...a: unknown[]) => mockList(...a),
      set: (...a: unknown[]) => mockSet(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
    },
  },
  getUserErrorMessage: (_e: unknown, d: string) => d,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en", setLocale: vi.fn() }),
}));

const KEY = "langsmith_api_key";
const secret = (key: string, configured: boolean) => ({ key, configured });

function render() {
  return renderHook(() => useInstanceSecret("bot-1", KEY));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ secrets: [] });
});

describe("useInstanceSecret", () => {
  it("reports a key the agent holds itself as configured", async () => {
    mockList.mockResolvedValue({ secrets: [secret(KEY, true)] });

    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configured).toBe(true);
  });

  it("reports a key the agent does not hold as not configured", async () => {
    mockList.mockResolvedValue({ secrets: [secret("openai_api_key", true)] });

    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configured).toBe(false);
  });

  /**
   * Reading secrets is admin-and-above, so a member gets a 403 — and must still
   * see the switch beside the field. Degrades to "not configured", never to a
   * thrown load.
   */
  it("degrades to not configured when the list is forbidden", async () => {
    mockList.mockRejectedValue(new Error("403"));

    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configured).toBe(false);
  });

  /**
   * Empty means "nothing typed", NOT "clear it". A blank field must never reach a
   * write — clearing is `remove`, which is confirmed.
   */
  it("is not dirty for an untouched or emptied field, and never writes one", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.dirty).toBe(false);

    act(() => result.current.setValue(""));
    expect(result.current.dirty).toBe(false);

    await act(async () => {
      await result.current.save();
    });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("writes a typed value under its own key", async () => {
    mockSet.mockResolvedValue({ secrets: [secret(KEY, true)] });
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setValue("ls-123"));
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    expect(mockSet).toHaveBeenCalledWith("bot-1", [{ key: KEY, value: "ls-123" }]);
    // Now stored: the field reports configured, and is no longer dirty — so a
    // second save of the same value cannot re-send it.
    expect(result.current.configured).toBe(true);
    expect(result.current.dirty).toBe(false);
  });

  it("measures a second edit from the last save, not from page load", async () => {
    mockSet.mockResolvedValue({ secrets: [] });
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setValue("first"));
    await act(async () => {
      await result.current.save();
    });
    act(() => result.current.setValue("second"));

    expect(result.current.dirty).toBe(true);
  });

  it("removes the agent's own key and forgets the typed value", async () => {
    mockList.mockResolvedValue({ secrets: [secret(KEY, true)] });
    mockDelete.mockResolvedValue({});
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setValue("typed-but-not-saved"));
    await act(async () => {
      await result.current.remove();
    });

    expect(mockDelete).toHaveBeenCalledWith("bot-1", KEY);
    expect(result.current.configured).toBe(false);
    expect(result.current.value).toBe("");
  });

  it("toggles visibility", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.visible).toBe(false);
    act(() => result.current.toggleVisibility());
    expect(result.current.visible).toBe(true);
  });
});
