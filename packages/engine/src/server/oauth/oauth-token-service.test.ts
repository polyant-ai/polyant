// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { needsRefresh } from "./oauth-token-service.js";

describe("needsRefresh", () => {
  const now = 1_000_000_000_000;
  const skew = 60_000;

  it("should_never_refresh_a_non_expiring_token", () => {
    expect(needsRefresh(null, now, skew)).toBe(false);
  });

  it("should_not_refresh_a_token_valid_beyond_the_skew_window", () => {
    expect(needsRefresh(new Date(now + 2 * skew), now, skew)).toBe(false);
  });

  it("should_refresh_a_token_expiring_within_the_skew_window", () => {
    expect(needsRefresh(new Date(now + skew / 2), now, skew)).toBe(true);
  });

  it("should_refresh_an_already_expired_token", () => {
    expect(needsRefresh(new Date(now - 1), now, skew)).toBe(true);
  });
});
