// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, sanitizeForLog, setLogTee } from "./create-logger.js";

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

describe("setLogTee", () => {
  afterEach(() => {
    setLogTee(null);
    vi.restoreAllMocks();
  });

  it("hands every formatted line to the tee with its level", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tee = vi.fn();
    setLogTee(tee);

    const log = createLogger();
    log.info("a", "hello");
    log.warn("a", "careful");
    log.error("a", "broke", new Error("why"));

    expect(tee.mock.calls.map((c) => c[0])).toEqual(["info", "warn", "error"]);
    expect(String(tee.mock.calls[2]![1])).toContain("broke — why");
  });
});
