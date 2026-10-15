// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { cachedValue } from "./ttl-cache.js";

describe("cachedValue", () => {
  it("shares one fetch between concurrent callers and serves it within the TTL", async () => {
    const fetch = vi.fn().mockResolvedValue("v");
    const cache = cachedValue(fetch, 10_000);
    await Promise.all([cache.get(), cache.get()]);
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches after invalidate", async () => {
    const fetch = vi.fn().mockResolvedValue("v");
    const cache = cachedValue(fetch, 10_000);
    await cache.get();
    cache.invalidate();
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected fetch", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");
    const cache = cachedValue(fetch, 10_000);
    await expect(cache.get()).rejects.toThrow("boom");
    await expect(cache.get()).resolves.toBe("ok");
  });
});
