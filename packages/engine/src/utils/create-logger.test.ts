// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { DrizzleQueryError } from "drizzle-orm";
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

describe("error cause chain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function capture(level: string, fn: (log: import("./create-logger.js").Logger) => void | Promise<void>): Promise<string> {
    vi.stubEnv("LOG_LEVEL", level);
    vi.resetModules();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (out.push(String(c)), true));
    const { createLogger: make } = await import("./create-logger.js");
    await fn(make());
    return out.join("");
  }

  for (const level of ["info", "debug"]) {
    it(`prints the underlying reason of a wrapped error at ${level}`, async () => {
      const driver = Object.assign(new Error('duplicate key value violates unique constraint "uq_x"'), { code: "23505" });
      const wrapped = new Error("Failed query: insert into t (a) values ($1)", { cause: driver });
      const text = await capture(level, (log) => log.error("pipeline", "Failed to flush conversation state", wrapped));
      expect(text).toContain("uq_x");
      expect(text).toContain("[23505]");
    });
  }

  it("keeps the cause of a failed fetch", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let err: unknown;
    try {
      await fetch(`http://127.0.0.1:${port}/x`);
    } catch (e) {
      err = e;
    }
    const text = await capture("info", (log) => log.error("whatsapp", "Media download failed", err));
    expect(text).toMatch(/ECONNREFUSED/);
  });

  it("follows at most three causes and sanitizes each", async () => {
    const chain = new Error("top", {
      cause: new Error("c1\n[INFO] forged", { cause: new Error("c2", { cause: new Error("c3", { cause: new Error("c4") }) }) }),
    });
    const text = await capture("info", (log) => log.warn("t", "failed", chain));
    expect(text).toContain("top ← c1 [INFO] forged ← c2 ← c3");
    expect(text).not.toContain("c4");
    expect(text.split("\n").filter(Boolean)).toHaveLength(1);
  });

  describe("failed drizzle queries", () => {
    const sql = "insert into ai_logs (conversation_id, body) values ($1, $2)";
    const secret = "MESSAGE-BODY-SECRET-4711";
    const driver = Object.assign(new Error('duplicate key value violates unique constraint "uq_x"'), { code: "23505" });

    for (const level of ["info", "debug"]) {
      it(`keeps the SQL and the driver code but not the parameter values at ${level}`, async () => {
        const err = new DrizzleQueryError(sql, ["conv-1", secret], driver);
        const text = await capture(level, (log) => log.error("buffered-insert", "flush failed", err));
        expect(text).not.toContain(secret);
        expect(text).not.toContain("params:");
        expect(text).toContain(`Failed query: ${sql}`);
        expect(text).toContain("uq_x");
        expect(text).toContain("[23505]");
      });
    }

    it("redacts the values when the drizzle error sits inside the cause chain", async () => {
      const inner = new DrizzleQueryError(sql, ["conv-1", secret], driver);
      const outer = new Error("transaction failed", { cause: inner });
      const text = await capture("info", (log) => log.warn("t", "failed", outer));
      expect(text).not.toContain(secret);
      expect(text).toContain("transaction failed ← Failed query: " + sql);
    });
  });

  it("does not print the tail of a multi-line message again as stack lines", async () => {
    const err = new Error("Failed query: insert\nparams: 1,2");
    err.stack = "Error: Failed query: insert\nparams: 1,2\n    at first (a.ts:1:1)";
    const text = await capture("debug", (log) => log.error("t", "failed", err));
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("at first (a.ts:1:1)");
  });
});
