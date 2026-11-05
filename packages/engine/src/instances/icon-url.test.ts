// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildInstanceIconUrl } from "./icon-url.js";

describe("buildInstanceIconUrl", () => {
  it("should_return_a_relative_url_when_the_agent_has_an_icon", () => {
    // Regression: the activity stream used to emit the raw data URI, which the
    // web guard `isSafeImageSrc` rejects, so the base64 leaked through as text.
    const url = buildInstanceIconUrl("acme", true, new Date(1700000000000));
    expect(url).toBe("/api/instances/acme/icon?v=1700000000000");
    expect(url).not.toContain("base64");
    expect(url?.startsWith("/")).toBe(true);
    expect(url?.startsWith("//")).toBe(false);
  });

  it("should_use_zero_version_when_updatedAt_is_null", () => {
    expect(buildInstanceIconUrl("acme", true, null)).toBe("/api/instances/acme/icon?v=0");
  });

  it("should_return_null_when_there_is_no_icon", () => {
    expect(buildInstanceIconUrl("acme", false, new Date(1700000000000))).toBeNull();
  });
});
