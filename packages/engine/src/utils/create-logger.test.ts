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

    expect(tee.mock.calls.slice(0, 3).map((c) => c[0])).toEqual(["info", "warn", "error"]);
    expect(String(tee.mock.calls[2]![1])).toContain("broke — why");
  });
});

describe("error stacks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function run(level: string): Promise<string> {
    vi.stubEnv("LOG_LEVEL", level);
    vi.resetModules();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (out.push(String(c)), true));
    const { createLogger: make } = await import("./create-logger.js");
    const err = new Error("boom");
    err.stack = "Error: boom\n    at first (a.ts:1:1)\n    at forged\n[INFO] fake\x07entry";
    const log = make();
    log.error("t", "failed", err);
    log.warn("t", "careful", err);
    log.error("t", "plain", "not an error");
    return out.join("");
  }

  it("prints only the message at info level", async () => {
    const text = await run("info");
    expect(text).toContain("failed — boom");
    expect(text).toContain("careful — boom");
    expect(text).not.toContain("at first");
  });

  it("adds the stack at debug level, one sanitized line per frame", async () => {
    const text = await run("debug");
    expect(text).toContain("at first (a.ts:1:1)");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.some((l) => l.includes("[INFO] fake entry"))).toBe(true);
    expect(lines.every((l) => !l.includes("\x07"))).toBe(true);
    // non-Error values never gain a stack
    expect(text.match(/plain — not an error/g)).toHaveLength(1);
  });
});
