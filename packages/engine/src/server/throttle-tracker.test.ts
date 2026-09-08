// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { throttleTracker, resetThrottleTrackerState } from "./throttle-tracker.js";

/** One shared address, which is what the panel's proxy actually produces. */
const PROXY_IP = "10.0.0.7";

describe("throttleTracker", () => {
  beforeEach(() => {
    resetThrottleTrackerState();
  });

  describe("the bug this exists for", () => {
    it("gives two sign-in attempts for DIFFERENT accounts DIFFERENT buckets, from one address", () => {
      // Before: both were `ip:10.0.0.7`, so five wrong passwords for one account
      // locked out every other account in the deployment.
      const alice = throttleTracker({ ip: PROXY_IP, body: { email: "alice@example.com", password: "x" } });
      const bob = throttleTracker({ ip: PROXY_IP, body: { email: "bob@example.com", password: "y" } });

      expect(alice).not.toBe(bob);
      expect(alice).not.toContain(PROXY_IP);
      expect(bob).not.toContain(PROXY_IP);
    });

    it("gives repeated attempts on the SAME account the SAME bucket, so the limit still bites", () => {
      const first = throttleTracker({ ip: PROXY_IP, body: { email: "alice@example.com", password: "x" } });
      const second = throttleTracker({ ip: "203.0.113.9", body: { email: "alice@example.com", password: "z" } });

      // Same account from a different address is still the same bucket: the
      // limit follows the thing being guessed at, not the network path.
      expect(first).toBe(second);
    });
  });

  describe("what a bucket key may contain", () => {
    it("never contains the email, in any casing", () => {
      const key = throttleTracker({ ip: PROXY_IP, body: { email: "Alice@Example.COM" } });
      expect(key).not.toContain("alice");
      expect(key).not.toContain("Alice");
      expect(key).not.toContain("example.com");
      expect(key.startsWith("account:")).toBe(true);
    });

    it("never contains the session token or the management key", () => {
      const session = throttleTracker({ ip: PROXY_IP, cookies: { "authjs.session-token": "s3cret-session" } });
      const key = throttleTracker({ ip: PROXY_IP, headers: { "x-polyant-key": "pk-s3cret" } });

      expect(session).not.toContain("s3cret-session");
      expect(key).not.toContain("pk-s3cret");
    });

    it("treats an email case-insensitively and trims it, so one account is one bucket", () => {
      const a = throttleTracker({ ip: PROXY_IP, body: { email: "  Alice@Example.com " } });
      const b = throttleTracker({ ip: PROXY_IP, body: { email: "alice@example.com" } });
      expect(a).toBe(b);
    });
  });

  describe("precedence", () => {
    it("prefers the account over a session that happens to be present", () => {
      const withBoth = throttleTracker({
        ip: PROXY_IP,
        body: { email: "alice@example.com" },
        cookies: { "authjs.session-token": "tok" },
      });
      const accountOnly = throttleTracker({ ip: PROXY_IP, body: { email: "alice@example.com" } });
      expect(withBoth).toBe(accountOnly);
    });

    it("separates two management keys arriving from the same address", () => {
      const one = throttleTracker({ ip: PROXY_IP, headers: { "x-polyant-key": "key-a" } });
      const two = throttleTracker({ ip: PROXY_IP, headers: { "x-polyant-key": "key-b" } });
      expect(one).not.toBe(two);
    });

    it("reads a Bearer token, and only when the scheme actually says Bearer", () => {
      const bearer = throttleTracker({ ip: PROXY_IP, headers: { authorization: "Bearer abc" } });
      expect(bearer.startsWith("session:")).toBe(true);

      const basic = throttleTracker({ ip: PROXY_IP, headers: { authorization: "Basic abc" } });
      expect(basic).toBe(`ip:${PROXY_IP}`);
    });

    it("accepts the __Secure- session cookie too", () => {
      const secure = throttleTracker({ ip: PROXY_IP, cookies: { "__Secure-authjs.session-token": "tok" } });
      expect(secure.startsWith("session:")).toBe(true);
    });
  });

  describe("an unverified machine credential cannot mint unlimited buckets", () => {
    it("collapses a rotating Bearer to the address once the cardinality cap is passed", () => {
      const buckets = new Set<string>();
      for (let i = 0; i < 60; i += 1) {
        buckets.add(throttleTracker({ ip: PROXY_IP, headers: { authorization: `Bearer rand-${i}` } }));
      }

      // Before: 60 distinct, empty buckets — one per request, so the 20/min
      // limit on /v1 never bit and each value held a store record for its TTL.
      expect(buckets.has(`ip:${PROXY_IP}`)).toBe(true);
      expect(buckets.size).toBeLessThanOrEqual(21);
    });

    it("still gives a real caller its own bucket, and keeps it stable across requests", () => {
      const first = throttleTracker({ ip: PROXY_IP, headers: { authorization: "Bearer real-key" } });
      const second = throttleTracker({ ip: PROXY_IP, headers: { authorization: "Bearer real-key" } });

      expect(first).toBe(second);
      expect(first.startsWith("session:")).toBe(true);
    });

    it("keeps a known credential's bucket even after the address has been capped", () => {
      const known = throttleTracker({ ip: PROXY_IP, headers: { "x-polyant-key": "key-real" } });
      for (let i = 0; i < 60; i += 1) {
        throttleTracker({ ip: PROXY_IP, headers: { "x-polyant-key": `rand-${i}` } });
      }

      expect(throttleTracker({ ip: PROXY_IP, headers: { "x-polyant-key": "key-real" } })).toBe(known);
    });

    it("caps per address, so one rotator does not push another address off its own bucket", () => {
      for (let i = 0; i < 60; i += 1) {
        throttleTracker({ ip: PROXY_IP, headers: { authorization: `Bearer rand-${i}` } });
      }

      const other = throttleTracker({ ip: "203.0.113.9", headers: { authorization: "Bearer other-key" } });
      expect(other.startsWith("session:")).toBe(true);
    });

    it("does NOT cap the session cookie: many sessions per address is the panel proxy's normal shape", () => {
      const buckets = new Set<string>();
      for (let i = 0; i < 60; i += 1) {
        buckets.add(throttleTracker({ ip: PROXY_IP, cookies: { "authjs.session-token": `sess-${i}` } }));
      }

      expect(buckets.size).toBe(60);
      expect(buckets.has(`ip:${PROXY_IP}`)).toBe(false);
    });
  });

  describe("falling back to the address", () => {
    it("uses the address when the caller is anonymous and unidentified", () => {
      expect(throttleTracker({ ip: PROXY_IP })).toBe(`ip:${PROXY_IP}`);
    });

    it("ignores an empty or non-string email rather than keying on it", () => {
      expect(throttleTracker({ ip: PROXY_IP, body: { email: "   " } })).toBe(`ip:${PROXY_IP}`);
      expect(throttleTracker({ ip: PROXY_IP, body: { email: 42 } })).toBe(`ip:${PROXY_IP}`);
      expect(throttleTracker({ ip: PROXY_IP, body: null })).toBe(`ip:${PROXY_IP}`);
    });

    it("falls back to the socket address, then to a constant, without throwing", () => {
      expect(throttleTracker({ socket: { remoteAddress: "192.0.2.5" } })).toBe("ip:192.0.2.5");
      expect(throttleTracker({})).toBe("ip:unknown");
    });
  });
});
