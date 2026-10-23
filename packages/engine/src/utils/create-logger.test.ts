// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { MCPClientError } from "@ai-sdk/mcp";
import { APICallError, JSONParseError, TypeValidationError } from "ai";
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
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

  describe("what the model returned, inside AI SDK errors", () => {
    const REPLY = "Booked for Mario Rossi, via Roma 12";

    /** The SDK's error for a 200 response whose JSON fails the provider schema; the validator is zod v3, like the engine's. */
    function failedValidation(): Error {
      const value = { output: [{ phase: "Mario Rossi", content: [{ type: "output_text", text: REPLY }] }] };
      const issues = z.object({ output: z.array(z.object({ phase: z.enum(["final"]) })) }).safeParse(value).error;
      return new APICallError({
        message: "Invalid JSON response",
        url: "https://provider.test/v1/responses",
        requestBodyValues: {},
        statusCode: 200,
        cause: TypeValidationError.wrap({ value, cause: issues }),
      });
    }

    /**
     * The SDK's error for a 200 response that is not JSON, with the real JSON.parse
     * error under it, which quotes the start of the body.
     */
    function failedParse(): Error {
      const body = "Mario Rossi, via Roma 12: booked";
      let syntax: unknown;
      try {
        JSON.parse(body);
      } catch (e) {
        syntax = e;
      }
      expect(String((syntax as Error).message)).toContain("Mario Ross");
      return new APICallError({
        message: "Invalid JSON response",
        url: "https://provider.test/v1/responses",
        requestBodyValues: {},
        statusCode: 200,
        cause: new JSONParseError({ text: body, cause: syntax }),
      });
    }

    for (const level of ["info", "error"]) {
      it(`names a failed validation and prints neither the response nor the rejected value at ${level}`, async () => {
        const text = await capture(level, (log) => log.error("telegram", "Error handling message", failedValidation()));
        expect(text).toContain("Invalid JSON response ← AI_TypeValidationError");
        expect(text).not.toContain("Mario Ross");
      });
    }

    it("names a failed parse and does not print the parser's quote of the body", async () => {
      const text = await capture("info", (log) => log.error("pipeline", "Memory extraction failed", failedParse()));
      expect(text).toContain("AI_JSONParseError");
      expect(text).not.toContain("Mario Ross");
    });

    it("prints no chain under an AI SDK error logged directly, as the engine passes them on", async () => {
      // The MCP client's error for a message its schema rejects: a safe message, the validator's issues as cause.
      const issues = z.object({ phase: z.enum(["final"]) }).safeParse({ phase: "Mario Rossi" }).error;
      const err = new MCPClientError({ message: "MCP HTTP Transport Error: Failed to parse message", cause: issues });
      const text = await capture("info", (log) => log.error("mcp", "tool call failed", err));
      expect(text).toContain("tool call failed — MCP HTTP Transport Error: Failed to parse message");
      expect(text).not.toContain("Mario Ross");
    });

    it("keeps a provider call's message and the network reason under it", async () => {
      const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:443"), { code: "ECONNREFUSED" });
      const err = new APICallError({
        message: "Cannot connect to API: fetch failed",
        url: "https://provider.test/v1/responses",
        requestBodyValues: {},
        cause: refused,
      });
      const text = await capture("info", (log) => log.warn("pipeline", "Summary failed", new Error("summary", { cause: err })));
      expect(text).toContain("summary ← Cannot connect to API: fetch failed ← connect ECONNREFUSED 10.0.0.5:443 [ECONNREFUSED]");
    });

    it("prints everything at debug, where it is asked for", async () => {
      const text = await capture("debug", (log) => log.error("telegram", "Error handling message", failedValidation()));
      expect(text).toContain("Mario Rossi");
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
