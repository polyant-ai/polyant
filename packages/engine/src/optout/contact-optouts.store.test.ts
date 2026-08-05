// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { OptoutStatusCache } from "./contact-optouts.store.js";

describe("OptoutStatusCache", () => {
  it("loads on miss and serves subsequent reads from cache", async () => {
    const loader = vi.fn().mockResolvedValue("opted_out");
    const cache = new OptoutStatusCache(loader);
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_out");
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_out");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidates a single contact on write", async () => {
    const loader = vi.fn().mockResolvedValueOnce("opted_in").mockResolvedValueOnce("opted_out");
    const cache = new OptoutStatusCache(loader);
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_in");
    cache.invalidate("inst", "whatsapp", "+39111");
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_out");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keys are scoped per (instance, channel, id)", async () => {
    const loader = vi.fn(async (_i: string, _c: string, id: string) => (id === "a" ? "opted_out" : "opted_in"));
    const cache = new OptoutStatusCache(loader);
    expect(await cache.get("inst", "whatsapp", "a")).toBe("opted_out");
    expect(await cache.get("inst", "whatsapp", "b")).toBe("opted_in");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
