// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A retired variable left in the environment is read by nothing, and the
 * operator who set it believes it still holds. The engine names it at boot.
 */

import { describe, it, expect } from "vitest";
import { retiredEnvironmentWarnings } from "./config-retired.js";

describe("retiredEnvironmentWarnings", () => {
  it("names a retired variable still set, and where its value lives now", () => {
    const warnings = retiredEnvironmentWarnings({ THROTTLE_LIMIT: "100", PATH: "/usr/bin" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("THROTTLE_LIMIT");
    expect(warnings[0]).toContain("Settings → General");
  });

  it("says nothing for an environment without retired variables, or with them emptied", () => {
    expect(retiredEnvironmentWarnings({ THROTTLE_ENABLED: "false", THROTTLE_LIMIT: "" })).toEqual([]);
  });

  it("names each platform bucket variable, which attachment storage no longer reads", () => {
    const warnings = retiredEnvironmentWarnings({
      PLATFORM_S3_BUCKET: "uploads",
      PLATFORM_S3_REGION: "eu-west-1",
      PLATFORM_S3_ACCESS_KEY_ID: "AKIA",
      PLATFORM_S3_SECRET_ACCESS_KEY: "do-not-print-me",
    });

    expect(warnings).toHaveLength(4);
    for (const w of warnings) expect(w).toContain("fileUpload");
    // The warning names the variable, never its value.
    expect(warnings.join("\n")).not.toContain("do-not-print-me");
  });
});
