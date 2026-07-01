// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { fetchMediaFollowingRedirects } from "./media-fetch.js";

const TWILIO = "https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME";
const CDN = "https://media.twiliocdn.com/AC/ME.jpg";

function res(status: number, opts: { location?: string } = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => (n.toLowerCase() === "location" ? opts.location ?? null : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}
const okDispatcher = async (_url: URL) => ({ dispatcher: {} });
const sig = () => new AbortController().signal;

describe("fetchMediaFollowingRedirects", () => {
  it("follows a cross-host 302 and drops Authorization on host change", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchFn = vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
      calls.push({ url, auth: init.headers?.["Authorization"] });
      return url.startsWith(TWILIO) ? res(302, { location: CDN }) : res(200);
    }) as unknown as typeof fetch;

    const r = await fetchMediaFollowingRedirects(TWILIO, "BASIC", { fetchFn, makeDispatcher: okDispatcher, signal: sig() });
    expect(r?.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBe("Basic BASIC"); // host Twilio → auth inviata
    expect(calls[1].auth).toBeUndefined(); // host CDN → auth DROPPATA (no leak)
  });

  it("re-validates SSRF (makeDispatcher) on every hop, per-host", async () => {
    const fetchFn = vi.fn(async (url: string) => (url.startsWith(TWILIO) ? res(302, { location: CDN }) : res(200))) as unknown as typeof fetch;
    const makeDispatcher = vi.fn(okDispatcher);
    await fetchMediaFollowingRedirects(TWILIO, "B", { fetchFn, makeDispatcher, signal: sig() });
    expect(makeDispatcher).toHaveBeenCalledTimes(2);
    expect((makeDispatcher.mock.calls[0][0] as URL).host).toBe("api.twilio.com");
    expect((makeDispatcher.mock.calls[1][0] as URL).host).toBe("media.twiliocdn.com");
  });

  it("returns null when a redirect hop fails the SSRF check (blocked private IP)", async () => {
    const fetchFn = vi.fn(async () => res(302, { location: "http://169.254.169.254/latest/meta-data" })) as unknown as typeof fetch;
    const makeDispatcher = async (url: URL) => {
      if (url.host !== "api.twilio.com") throw new Error("blocked private IP");
      return { dispatcher: {} };
    };
    const r = await fetchMediaFollowingRedirects(TWILIO, "B", { fetchFn, makeDispatcher, signal: sig() });
    expect(r).toBeNull();
  });

  it("returns the response directly when there is no redirect", async () => {
    const fetchFn = vi.fn(async () => res(200)) as unknown as typeof fetch;
    const r = await fetchMediaFollowingRedirects(TWILIO, "B", { fetchFn, makeDispatcher: okDispatcher, signal: sig() });
    expect(r?.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects → null", async () => {
    const fetchFn = vi.fn(async () => res(302, { location: CDN })) as unknown as typeof fetch;
    const r = await fetchMediaFollowingRedirects(TWILIO, "B", { fetchFn, makeDispatcher: okDispatcher, signal: sig() });
    expect(r).toBeNull();
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(4); // hop 0..3
  });

  it("returns null on an invalid URL", async () => {
    const r = await fetchMediaFollowingRedirects("not a url", "B", { fetchFn: (async () => res(200)) as unknown as typeof fetch, makeDispatcher: okDispatcher, signal: sig() });
    expect(r).toBeNull();
  });
});
