// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

const wrapper = ({ children }: { children: React.ReactNode }) => <I18nProvider initialLocale="en">{children}</I18nProvider>;
const error = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error } }));

afterEach(() => vi.restoreAllMocks());

describe("useCopyToClipboard", () => {
  it("reports copied only after the write resolves", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { result } = renderHook(() => useCopyToClipboard(), { wrapper });
    let ok = false;
    await act(async () => { ok = await result.current.copy("x"); });
    expect(ok).toBe(true);
    expect(result.current.copied).toBe(true);
  });

  it("toasts an error and stays uncopied when the write rejects", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const { result } = renderHook(() => useCopyToClipboard(), { wrapper });
    let ok = true;
    await act(async () => { ok = await result.current.copy("x"); });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});
