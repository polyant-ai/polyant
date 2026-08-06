// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { sanitizeForLog } from "./create-logger.js";

describe("sanitizeForLog", () => {
  it("collapses newlines so untrusted text cannot forge a second log line", () => {
    // The whole point: this payload must not become two records in the log file.
    const forged = "acme\n[INFO] 2026-01-01 user=admin action=login";

    const safe = sanitizeForLog(forged);

    expect(safe).not.toContain("\n");
    expect(safe).toBe("acme [INFO] 2026-01-01 user=admin action=login");
  });

  it("strips carriage returns and other control characters", () => {
    expect(sanitizeForLog("a\rb\tc\x00d")).toBe("a b c d");
  });

  it("leaves ordinary text — including non-ASCII — untouched", () => {
    expect(sanitizeForLog("istanza-café-日本語")).toBe("istanza-café-日本語");
  });

  it("is a no-op on an empty string", () => {
    expect(sanitizeForLog("")).toBe("");
  });
});
